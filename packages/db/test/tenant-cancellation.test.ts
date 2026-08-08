import { newId } from '@zapp/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import { forOrg } from '../src/tenant.js';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

describe('tenant event replay cancellation', () => {
  it('settles the driver CancelRequest before releasing its reserved connection', async () => {
    // Break caught: postgres.js Query.cancel() discards the driver's cancellation
    // promise. Releasing before that promise settles lets the delayed request
    // cancel the next query that reuses the same PostgreSQL backend.
    const cancellation = deferred();
    let rejectQuery!: (reason: Error) => void;
    const cancelDriver = vi.fn(() => {
      rejectQuery(new Error('canceling statement due to user request'));
      return cancellation.promise;
    });
    const pending = Object.assign(
      new Promise<never>((_resolve, reject) => {
        rejectQuery = reject;
      }),
      {
        execute: vi.fn(),
        cancel: vi.fn(() => {
          rejectQuery(new Error('canceling statement due to user request'));
        }),
        canceller: cancelDriver,
        active: true,
      },
    );
    const release = vi.fn();
    const reserved = {
      unsafe: vi.fn(() => pending),
      release,
    };
    const database = {
      $client: {
        reserve: vi.fn(() => Promise.resolve(reserved)),
      },
    } as unknown as Database;
    const controller = new AbortController();
    const read = forOrg(database, newId('org')).events.byRun(newId('run'), {
      signal: controller.signal,
    });
    const outcome = read.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(pending.execute).toHaveBeenCalledOnce();
    });

    controller.abort();
    await vi.waitFor(() => {
      expect(pending.cancel.mock.calls.length + cancelDriver.mock.calls.length).toBe(1);
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(release).not.toHaveBeenCalled();
    cancellation.resolve();
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('fails closed without launching an unawaitable cancellation if the driver shape changes', async () => {
    // Break caught: falling back to Query.cancel() would discard its runtime
    // promise and recreate the late-cancel race this adapter exists to prevent.
    let resolveQuery!: (rows: never[]) => void;
    const pending = Object.assign(
      new Promise<never[]>((resolve) => {
        resolveQuery = resolve;
      }),
      {
        execute: vi.fn(),
        cancel: vi.fn(),
      },
    );
    const release = vi.fn();
    const database = {
      $client: {
        reserve: vi.fn(() =>
          Promise.resolve({
            unsafe: vi.fn(() => pending),
            release,
          }),
        ),
      },
    } as unknown as Database;
    const controller = new AbortController();
    const read = forOrg(database, newId('org')).events.byRun(newId('run'), {
      signal: controller.signal,
    });
    const outcome = read.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(pending.execute).toHaveBeenCalledOnce();
    });

    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));

    expect(pending.cancel).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    resolveQuery([]);
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not cancel a query that settled before its abort listener ran', async () => {
    // Break caught: postgres.js defers cancellation when its Query is inactive.
    // Invoking that path after a fast replay completed can cancel a later query
    // after this reserved backend has been returned to the pool.
    let resolveQuery!: (rows: never[]) => void;
    const cancelDriver = vi.fn(() => Promise.resolve());
    const pending = Object.assign(
      new Promise<never[]>((resolve) => {
        resolveQuery = resolve;
      }),
      {
        execute: vi.fn(),
        canceller: cancelDriver,
        active: true,
      },
    );
    const release = vi.fn();
    const database = {
      $client: {
        reserve: vi.fn(() =>
          Promise.resolve({
            unsafe: vi.fn(() => pending),
            release,
          }),
        ),
      },
    } as unknown as Database;
    const controller = new AbortController();
    const read = forOrg(database, newId('org')).events.byRun(newId('run'), {
      signal: controller.signal,
    });
    const outcome = read.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(pending.execute).toHaveBeenCalledOnce();
    });

    pending.active = false;
    resolveQuery([]);
    controller.abort();

    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(cancelDriver).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('drains a late CancelRequest on the reserved backend before releasing it', async () => {
    // Break caught: the cancellation socket can close after PostgreSQL accepted
    // the request but before its signal reaches a replay that just completed.
    // A synchronization query on the same backend must absorb that signal.
    const cancellation = deferred();
    let resolveReplay!: (rows: never[]) => void;
    const cancelDriver = vi.fn(() => cancellation.promise);
    const replay = Object.assign(
      new Promise<never[]>((resolve) => {
        resolveReplay = resolve;
      }),
      {
        execute: vi.fn(),
        canceller: cancelDriver,
        active: true,
      },
    );
    let rejectDrain!: (reason: Error) => void;
    const drain = Object.assign(
      new Promise<never[]>((_resolve, reject) => {
        rejectDrain = reject;
      }),
      { execute: vi.fn() },
    );
    const release = vi.fn();
    const unsafe = vi.fn().mockReturnValueOnce(replay).mockReturnValueOnce(drain);
    const database = {
      $client: {
        reserve: vi.fn(() => Promise.resolve({ unsafe, release })),
      },
    } as unknown as Database;
    const controller = new AbortController();
    const read = forOrg(database, newId('org')).events.byRun(newId('run'), {
      signal: controller.signal,
    });
    const outcome = read.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(replay.execute).toHaveBeenCalledOnce();
    });

    controller.abort();
    replay.active = false;
    resolveReplay([]);
    cancellation.resolve();
    await vi.waitFor(() => {
      expect(unsafe).toHaveBeenCalledTimes(2);
    });

    expect(release).not.toHaveBeenCalled();
    rejectDrain(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
  });
});
