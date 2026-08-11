import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { githubWebhookDeliveries, type Database } from '@zapp/db';
import { and, asc, eq, lte } from 'drizzle-orm';

import type { RedisCommands } from '../../redis/client.js';
import {
  GitHubAuthorizationBindingSchema,
  GitHubWebhookReceiptSchema,
  type GitHubAuthorizationBinding,
  type GitHubWebhookReceipt,
} from './schemas.js';

export type { GitHubWebhookEventName, GitHubWebhookReceipt } from './schemas.js';

export const GITHUB_AUTHORIZATION_STATE_TTL_MS = 600_000;

export interface GitHubAuthorizationStateStore {
  issue(binding: GitHubAuthorizationBinding, ttlMs: number): Promise<string>;
  consume(state: string, binding: GitHubAuthorizationBinding): Promise<boolean>;
}

interface StateEntry {
  readonly binding: string;
  readonly expiresAt: number;
}

function encodedBinding(binding: GitHubAuthorizationBinding): string {
  return JSON.stringify(GitHubAuthorizationBindingSchema.parse(binding));
}

export function createInMemoryGitHubAuthorizationStateStore(
  now: () => Date = () => new Date(),
): GitHubAuthorizationStateStore {
  const states = new Map<string, StateEntry>();
  return {
    issue(binding, ttlMs) {
      const state = randomBytes(32).toString('base64url');
      states.set(state, {
        binding: encodedBinding(binding),
        expiresAt: now().getTime() + Math.max(1, Math.ceil(ttlMs)),
      });
      return Promise.resolve(state);
    },
    consume(state, binding) {
      const entry = states.get(state);
      if (entry === undefined) return Promise.resolve(false);
      if (entry.expiresAt <= now().getTime()) {
        states.delete(state);
        return Promise.resolve(false);
      }
      const expected = Buffer.from(entry.binding);
      const actual = Buffer.from(encodedBinding(binding));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return Promise.resolve(false);
      }
      states.delete(state);
      return Promise.resolve(true);
    },
  };
}

const CONSUME = `
  local stored = redis.call('GET', KEYS[1])
  if not stored or stored ~= ARGV[1] then
    return 0
  end
  redis.call('DEL', KEYS[1])
  return 1
`;

function stateKey(state: string): string {
  return `github:install-state:${createHash('sha256').update(state).digest('hex')}`;
}

export function createRedisGitHubAuthorizationStateStore(
  redis: RedisCommands,
): GitHubAuthorizationStateStore {
  return {
    async issue(binding, ttlMs) {
      const state = randomBytes(32).toString('base64url');
      await redis.set(stateKey(state), encodedBinding(binding), Math.max(1, Math.ceil(ttlMs)));
      return state;
    },
    async consume(state, binding) {
      const result = await redis.eval(CONSUME, [stateKey(state)], [encodedBinding(binding)]);
      return result === 1 || result === '1';
    },
  };
}

export interface GitHubWebhookPublishInput {
  readonly limit: number;
  readonly now: Date;
  readonly send: (input: GitHubWebhookReceipt) => Promise<void>;
  readonly onError?: (error: Error) => void;
}

export interface GitHubWebhookStore {
  claim(receipt: GitHubWebhookReceipt): Promise<boolean>;
  publishBatch(input: GitHubWebhookPublishInput): Promise<number>;
}

export function createDbGitHubWebhookStore(database: Database): GitHubWebhookStore {
  return {
    async claim(receipt) {
      const parsed = GitHubWebhookReceiptSchema.parse(receipt);
      const inserted = await database
        .insert(githubWebhookDeliveries)
        .values({
          deliveryId: parsed.deliveryId,
          eventName: parsed.eventName,
          payloadJson: parsed.payload,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: parsed.receivedAt,
          receivedAt: parsed.receivedAt,
          publishedAt: null,
        })
        .onConflictDoNothing({ target: githubWebhookDeliveries.deliveryId })
        .returning({ deliveryId: githubWebhookDeliveries.deliveryId });
      return inserted.length === 1;
    },
    async publishBatch(input) {
      return await database.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(githubWebhookDeliveries)
          .where(
            and(
              eq(githubWebhookDeliveries.status, 'pending'),
              lte(githubWebhookDeliveries.nextAttemptAt, input.now),
            ),
          )
          .orderBy(
            asc(githubWebhookDeliveries.receivedAt),
            asc(githubWebhookDeliveries.deliveryId),
          )
          .limit(input.limit)
          .for('update', { skipLocked: true });
        let published = 0;
        for (const row of rows) {
          try {
            const receipt = GitHubWebhookReceiptSchema.parse({
              deliveryId: row.deliveryId,
              eventName: row.eventName,
              payload: row.payloadJson,
              receivedAt: row.receivedAt,
            });
            await input.send(receipt);
            await tx
              .update(githubWebhookDeliveries)
              .set({
                status: 'published',
                attempts: row.attempts + 1,
                publishedAt: input.now,
              })
              .where(eq(githubWebhookDeliveries.deliveryId, row.deliveryId));
            published += 1;
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            input.onError?.(failure);
            const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 5));
            await tx
              .update(githubWebhookDeliveries)
              .set({
                attempts: row.attempts + 1,
                nextAttemptAt: new Date(input.now.getTime() + delayMs),
              })
              .where(eq(githubWebhookDeliveries.deliveryId, row.deliveryId));
          }
        }
        return published;
      });
    },
  };
}
