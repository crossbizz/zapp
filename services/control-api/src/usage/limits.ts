import { readFile } from 'node:fs/promises';

import {
  CreditStateSchema,
  CreditDecimalSchema,
  PlanLimitsConfigSchema,
  idSchema,
  type CreditState,
  type ResourceProfile,
  type PlanLimit,
  type PlanLimitsConfig,
} from '@zapp/contracts';
import { z } from 'zod';

import type { RedisCommands } from '../redis/client.js';

export { PlanLimitsConfigSchema, type PlanLimitsConfig, type PlanLimit } from '@zapp/contracts';

const ProfileRank: Readonly<Record<ResourceProfile, number>> = {
  small: 0,
  standard: 1,
  large: 2,
};

const ProfileAtRank: readonly ResourceProfile[] = ['small', 'standard', 'large'];

export function loadPlanLimitsConfig(input: unknown): PlanLimitsConfig {
  return PlanLimitsConfigSchema.parse(input);
}

export async function loadPlanLimitsFile(url: URL): Promise<PlanLimitsConfig> {
  return loadPlanLimitsConfig(JSON.parse(await readFile(url, 'utf8')) as unknown);
}

export function planLimitsFor(config: PlanLimitsConfig, plan: string): PlanLimit {
  return config[PlanLimitsConfigSchema.keyof().parse(plan)];
}

/** The sole plan-policy adapter the sandbox governor consumes for organization quotas. */
export function createPlanLimitsAdapter(options: {
  readonly plans: PlanLimitsConfig;
  readonly organizations: { findById(organizationId: string): Promise<{ readonly plan: string } | undefined> };
}): { getOrganizationLimits(organizationId: string): Promise<{ readonly concurrentSandboxes: number }> } {
  return {
    async getOrganizationLimits(organizationId) {
      const organization = await options.organizations.findById(idSchema('org').parse(organizationId));
      if (organization === undefined) throw new Error('organization plan is unavailable');
      return { concurrentSandboxes: planLimitsFor(options.plans, organization.plan).concurrentSandboxes };
    },
  };
}

export function clampResourceProfile(limit: PlanLimit, requested: ResourceProfile): ResourceProfile {
  return ProfileAtRank[Math.min(ProfileRank[requested], ProfileRank[limit.maxResourceProfile])] ?? 'small';
}

export function resolveRunBudget(
  limit: PlanLimit,
  explicit?: { readonly maxCredits: number },
): { readonly maxCredits: number } {
  const maxCredits = Number(limit.maxRunBudgetCredits);
  const requested = explicit?.maxCredits ?? maxCredits;
  return { maxCredits: Math.min(requested, maxCredits) };
}

export class PlanLimitConcurrentRunsError extends Error {
  public readonly code = 'plan_limit_concurrent_runs' as const;
  public readonly statusCode = 429 as const;

  public constructor() {
    super('The organization autonomous run limit is currently full.');
    this.name = 'PlanLimitConcurrentRunsError';
  }
}

export function assertConcurrentRunAdmission(input: {
  readonly limit: number;
  readonly active: number;
  readonly replay: boolean;
}): void {
  if (input.active >= input.limit && !input.replay) throw new PlanLimitConcurrentRunsError();
}

export interface FlexpriceWalletPort {
  getActivePrepaidBalance(organizationId: string): Promise<string>;
}

const FlexpriceWalletSchema = z
  .object({
    id: z.string().min(1),
    wallet_type: z.string().min(1),
    wallet_status: z.string().min(1),
    real_time_credit_balance: CreditDecimalSchema.optional(),
  })
  .passthrough();

const FlexpriceWalletListSchema = z.array(FlexpriceWalletSchema);

export function createFlexpriceWalletClient(options: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}): FlexpriceWalletPort {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = `${options.baseUrl.replace(/\/+$/u, '')}/`;
  return {
    async getActivePrepaidBalance(organizationId) {
      const customerId = idSchema('org').parse(organizationId);
      const url = new URL('customers/wallets', baseUrl);
      url.searchParams.set('lookup_key', customerId);
      url.searchParams.set('include_real_time_balance', 'true');
      const response = await request(url, {
        headers: { 'x-api-key': options.apiKey },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        throw new Error(`Flexprice customer wallets failed with status ${String(response.status)}`);
      }
      const wallets = FlexpriceWalletListSchema.parse(await response.json());
      const activePrepaid = wallets.filter(
        (wallet) => wallet.wallet_type === 'PRE_PAID' && wallet.wallet_status === 'active',
      );
      if (activePrepaid.length !== 1) {
        throw new Error('Flexprice did not return exactly one active prepaid wallet');
      }
      return CreditDecimalSchema.parse(activePrepaid[0]?.real_time_credit_balance);
    },
  };
}

export type UsageOpsAlert =
  | { readonly type: 'flexprice_wallet_unavailable'; readonly organizationId: string }
  | {
      readonly type: 'run_budget_threshold';
      readonly organizationId: string;
      readonly runId: string;
      readonly threshold: 50 | 80 | 100;
    };

/** OPS-7 owns delivery; usage enforcement emits only this narrow, non-blocking port. */
export interface UsageOpsAlertPort {
  emit(alert: UsageOpsAlert): Promise<void>;
}

export interface BudgetThresholdAlertPort {
  notify(input: {
    readonly organizationId: string;
    readonly runId: string;
    readonly credits: CreditState;
  }): Promise<void>;
}

const BUDGET_ALERT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const BUDGET_ALERT_THRESHOLDS = [50, 80, 100] as const;

/**
 * Redis gives each threshold one durable dedupe key per run. Notification loss
 * never changes accounting or blocks a completion; OPS-7 can replace the
 * delivery port without changing the credit path.
 */
export function createBudgetThresholdAlerts(options: {
  readonly redis: Pick<RedisCommands, 'setIfAbsent'>;
  readonly alerts: UsageOpsAlertPort;
}): BudgetThresholdAlertPort {
  return {
    async notify(input) {
      const organizationId = idSchema('org').parse(input.organizationId);
      const runId = idSchema('run').parse(input.runId);
      const credits = CreditStateSchema.parse(input.credits);
      const consumed = creditUnits(credits.used) + creditUnits(credits.reserved);
      const ceiling = creditUnits(credits.ceiling);
      if (ceiling <= 0n) return;
      for (const threshold of BUDGET_ALERT_THRESHOLDS) {
        if (consumed * 100n < ceiling * BigInt(threshold)) continue;
        try {
          const claimed = await options.redis.setIfAbsent(
            `run:${runId}:budget-alert:${String(threshold)}`,
            '1',
            BUDGET_ALERT_TTL_MS,
          );
          if (claimed) {
            await options.alerts.emit({
              type: 'run_budget_threshold',
              organizationId,
              runId,
              threshold,
            });
          }
        } catch {
          // Alert delivery must never make the accounting boundary unavailable.
        }
      }
    },
  };
}

export class CreditBalanceExhaustedError extends Error {
  public readonly code = 'credit_balance_exhausted' as const;
  public readonly statusCode = 402 as const;

  public constructor() {
    super('The organization credit balance is exhausted.');
    this.name = 'CreditBalanceExhaustedError';
  }
}

export interface CreditBalanceGate {
  availableCredits(organizationId: string): Promise<{
    readonly availableCredits: string;
    readonly walletBalance: string;
    readonly reservedCredits: string;
    readonly source: 'wallet' | 'cache' | 'grace';
  }>;
  requireRunAdmission(organizationId: string): Promise<void>;
}

const WALLET_CACHE_TTL_MS = 30_000;
const WALLET_LAST_KNOWN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const WalletCacheSchema = z
  .object({ balance: CreditDecimalSchema, cachedAt: z.number().int().nonnegative() })
  .strict();
const WalletLastKnownSchema = z.object({ balance: CreditDecimalSchema }).strict();

export function createCachedCreditBalanceGate(options: {
  readonly wallets: FlexpriceWalletPort;
  readonly redis: Pick<RedisCommands, 'get' | 'set'>;
  readonly activeRuns: { list(organizationId: string): Promise<readonly string[]> };
  readonly graceFloorCredits: string;
  readonly alerts: UsageOpsAlertPort;
  readonly now?: () => number;
}): CreditBalanceGate {
  const graceFloorCredits = CreditDecimalSchema.parse(options.graceFloorCredits);
  const now = options.now ?? Date.now;
  const freshKey = (organizationId: string): string => `organization:${organizationId}:wallet:credits:fresh`;
  const lastKnownKey = (organizationId: string): string => `organization:${organizationId}:wallet:credits:lkg`;

  async function reservedCredits(organizationId: string): Promise<string> {
    let total = 0n;
    for (const runId of await options.activeRuns.list(idSchema('org').parse(organizationId))) {
      const raw = await options.redis.get(`run:${runId}:credits`);
      if (raw === null) continue;
      const state = CreditStateSchema.parse(JSON.parse(raw) as unknown);
      total += creditUnits(state.reserved);
    }
    return formatCredits(total);
  }

  return {
    async availableCredits(organizationId) {
      const organization = idSchema('org').parse(organizationId);
      let walletBalance: string | undefined;
      let source: 'wallet' | 'cache' | 'grace' = 'wallet';
      try {
        const cached = await options.redis.get(freshKey(organization));
        if (cached !== null) {
          const fresh = WalletCacheSchema.parse(JSON.parse(cached) as unknown);
          if (now() - fresh.cachedAt <= WALLET_CACHE_TTL_MS) {
            walletBalance = fresh.balance;
            source = 'cache';
          }
        }
      } catch {
        // A cache failure is not a wallet failure; attempt the authority next.
      }
      if (walletBalance === undefined) {
        try {
          walletBalance = CreditDecimalSchema.parse(await options.wallets.getActivePrepaidBalance(organization));
          source = 'wallet';
          await Promise.allSettled([
            options.redis.set(
              freshKey(organization),
              JSON.stringify({ balance: walletBalance, cachedAt: now() }),
              WALLET_CACHE_TTL_MS,
            ),
            options.redis.set(
              lastKnownKey(organization),
              JSON.stringify({ balance: walletBalance }),
              WALLET_LAST_KNOWN_TTL_MS,
            ),
          ]);
        } catch {
          try {
            const retained = await options.redis.get(lastKnownKey(organization));
            if (retained !== null) {
              walletBalance = WalletLastKnownSchema.parse(JSON.parse(retained) as unknown).balance;
              source = 'cache';
            }
          } catch {
            // Redis failure falls through to the configured grace floor.
          }
          if (walletBalance === undefined) {
            walletBalance = graceFloorCredits;
            source = 'grace';
          }
          try {
            await options.alerts.emit({ type: 'flexprice_wallet_unavailable', organizationId: organization });
          } catch {
            // Ops alert delivery is best effort and must not block admissions.
          }
        }
      }
      const reserved = await reservedCredits(organization);
      return {
        availableCredits: formatCredits(creditUnits(walletBalance) - creditUnits(reserved)),
        walletBalance: formatCredits(creditUnits(walletBalance)),
        reservedCredits: reserved,
        source,
      };
    },
    async requireRunAdmission(organizationId) {
      const balance = await this.availableCredits(organizationId);
      if (creditUnits(balance.availableCredits) <= 0n) throw new CreditBalanceExhaustedError();
    },
  };
}

function creditUnits(value: string): bigint {
  const parsed = CreditDecimalSchema.parse(value);
  const [whole = '0', fraction = ''] = parsed.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
}

function formatCredits(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${String(absolute / 10_000n)}.${String(absolute % 10_000n).padStart(4, '0')}`;
}
