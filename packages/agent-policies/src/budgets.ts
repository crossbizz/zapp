import { CreditStateSchema } from '@zapp/contracts';
import { z } from 'zod';

export const PolicyBudgetSchema = z
  .object({
    remainingToolCalls: z.number().int().nonnegative(),
    remainingConsequentialToolCalls: z.number().int().nonnegative(),
  })
  .strict();

export type PolicyBudget = z.infer<typeof PolicyBudgetSchema>;

export const RunCreditBudgetDecisionSchema = z
  .object({
    level: z.enum(['ok', 'warning', 'exhausted']),
    utilizationBps: z.number().int().min(0).max(10_000),
  })
  .strict();

export type RunCreditBudgetDecision = z.infer<typeof RunCreditBudgetDecisionSchema>;

function creditUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0'));
}

/** Exact fixed-point run-budget policy. Reserved work counts toward the hard ceiling. */
export function evaluateRunCreditBudget(inputValue: unknown): RunCreditBudgetDecision {
  const input = CreditStateSchema.parse(inputValue);
  const ceiling = creditUnits(input.ceiling);
  if (ceiling === 0n) throw new RangeError('run credit ceiling must be positive');
  const consumed = creditUnits(input.used) + creditUnits(input.reserved);
  const utilizationBps = Number(
    consumed >= ceiling ? 10_000n : (consumed * 10_000n) / ceiling,
  );
  return RunCreditBudgetDecisionSchema.parse({
    level:
      utilizationBps >= 10_000
        ? 'exhausted'
        : utilizationBps >= 8_000
          ? 'warning'
          : 'ok',
    utilizationBps,
  });
}
