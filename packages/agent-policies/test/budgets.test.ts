import { describe, expect, it } from 'vitest';

import { evaluateRunCreditBudget } from '../src/budgets.js';

describe('run credit budget policy', () => {
  it.each([
    [{ used: '79.9999', reserved: '0.0000', ceiling: '100.0000', version: 1 }, 'ok', 7_999],
    [{ used: '80.0000', reserved: '0.0000', ceiling: '100.0000', version: 2 }, 'warning', 8_000],
    [{ used: '75.0000', reserved: '5.0000', ceiling: '100.0000', version: 3 }, 'warning', 8_000],
    [{ used: '100.0000', reserved: '0.0000', ceiling: '100.0000', version: 4 }, 'exhausted', 10_000],
  ] as const)('classifies %j as %s', (credits, level, utilizationBps) => {
    expect(evaluateRunCreditBudget(credits)).toEqual({ level, utilizationBps });
  });

  it('rejects malformed and zero ceilings instead of guessing', () => {
    expect(() =>
      evaluateRunCreditBudget({
        used: '1.0000',
        reserved: '0.0000',
        ceiling: '0.0000',
        version: 0,
      }),
    ).toThrow('credit ceiling');
  });
});
