import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SWEEP_INTERVAL_MS, scheduleTokenSweep } from '../src/sweep.js';
import type { TokenService } from '../src/tokens.js';

/**
 * The timer that makes a token's deadline real (GIT-3, fix round 1).
 *
 * Three things are worth pinning, and all three are ways the first cut of this
 * could have failed silently: that it actually fires, that a failing Git host
 * does not take the process down with it, and that the timer never keeps a
 * container alive past a shutdown.
 */

function fakeTokens(): TokenService & { sweeps: number; failNext(error: Error): void } {
  let failure: Error | undefined;
  const fake = {
    sweeps: 0,
    failNext(error: Error) {
      failure = error;
    },
    mint: () => Promise.reject(new Error('not used')),
    mintForRepository: () => Promise.reject(new Error('not used')),
    revokeForProject: () => Promise.reject(new Error('not used')),
    sweepExpired: () => {
      fake.sweeps += 1;
      if (failure !== undefined) {
        const thrown = failure;
        failure = undefined;
        return Promise.reject(thrown);
      }
      return Promise.resolve(1);
    },
  } as TokenService & { sweeps: number; failNext(error: Error): void };
  return fake;
}

interface FakeLog {
  readonly errors: unknown[];
  readonly debugs: unknown[];
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

function fakeLog(): FakeLog {
  const errors: unknown[] = [];
  const debugs: unknown[] = [];
  return {
    errors,
    debugs,
    error: (...args: unknown[]) => {
      errors.push(args);
    },
    debug: (...args: unknown[]) => {
      debugs.push(args);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleTokenSweep', () => {
  it('sweeps on the interval', async () => {
    const tokens = fakeTokens();
    const sweep = scheduleTokenSweep({ tokens, log: fakeLog(), intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(3_500);
    sweep.stop();

    // Forgejo has no expiring token, so this timer is the whole of "short-lived".
    expect(tokens.sweeps).toBe(3);
  });

  it('defaults to a minute, which bounds the overrun', async () => {
    const tokens = fakeTokens();
    const sweep = scheduleTokenSweep({ tokens, log: fakeLog() });

    await vi.advanceTimersByTimeAsync(DEFAULT_SWEEP_INTERVAL_MS - 1);
    expect(tokens.sweeps).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokens.sweeps).toBe(1);

    sweep.stop();
  });

  it('stops when told to', async () => {
    const tokens = fakeTokens();
    const sweep = scheduleTokenSweep({ tokens, log: fakeLog(), intervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    sweep.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    // `server.ts` calls this from `onClose`; a timer that outlived the app would
    // keep sweeping against a database handle that has been released.
    expect(tokens.sweeps).toBe(1);
  });

  it('logs a failure and keeps sweeping', async () => {
    const tokens = fakeTokens();
    const log = fakeLog();
    const sweep = scheduleTokenSweep({ tokens, log, intervalMs: 1_000 });

    tokens.failNext(new Error('forgejo is unreachable'));
    await vi.advanceTimersByTimeAsync(2_000);
    sweep.stop();

    // An unhandled rejection in a timer callback takes the process down, and a
    // Git host that is briefly unreachable must not restart the service that
    // talks to it. The next tick retries by construction.
    expect(log.errors).toHaveLength(1);
    expect(tokens.sweeps).toBe(2);
  });

  it('never holds the process open', () => {
    const unref = vi.spyOn(globalThis, 'setInterval');
    const tokens = fakeTokens();

    const sweep = scheduleTokenSweep({ tokens, log: fakeLog(), intervalMs: 1_000 });
    const timer = unref.mock.results[0]?.value as { hasRef?: () => boolean };

    // A container told to stop stops; it does not wait out an interval.
    expect(timer.hasRef?.()).toBe(false);
    sweep.stop();
    unref.mockRestore();
  });

  it('runs once on demand, reporting failure through the logger', async () => {
    const tokens = fakeTokens();
    const log = fakeLog();
    const sweep = scheduleTokenSweep({ tokens, log, intervalMs: 1_000 });

    tokens.failNext(new Error('nope'));
    // Never throws: the caller is a timer callback, and there is nothing above
    // it to catch.
    await expect(sweep.runOnce()).resolves.toBeUndefined();
    expect(log.errors).toHaveLength(1);
    sweep.stop();
  });
});
