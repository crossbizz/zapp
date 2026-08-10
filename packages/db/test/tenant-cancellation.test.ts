import { newId } from '@zapp/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import { forOrg } from '../src/tenant.js';

describe('tenant event replay cancellation', () => {
  it('holds the reserved connection until the publicly cancelled query settles', async () => {
    let rejectQuery!: (reason: Error) => void;
    const pending = Object.assign(
      new Promise<never>((_resolve, reject) => {
        rejectQuery = reject;
      }),
      {
        execute: vi.fn(),
        cancel: vi.fn(),
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
      expect(pending.cancel).toHaveBeenCalledOnce();
    });
    expect(release).not.toHaveBeenCalled();

    rejectQuery(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('fails closed on a cancellation API error until the query settles', async () => {
    let resolveQuery!: (rows: never[]) => void;
    const pending = Object.assign(
      new Promise<never[]>((resolve) => {
        resolveQuery = resolve;
      }),
      {
        execute: vi.fn(),
        cancel: vi.fn(() => {
          throw new Error('cancel failed');
        }),
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
    await vi.waitFor(() => {
      expect(pending.cancel).toHaveBeenCalledOnce();
    });
    expect(release).not.toHaveBeenCalled();

    resolveQuery([]);
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not cancel a query that settled before its abort listener ran', async () => {
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
    await vi.waitFor(() => {
      expect(pending.execute).toHaveBeenCalledOnce();
    });

    resolveQuery([]);
    await expect(read).resolves.toEqual([]);
    controller.abort();

    expect(pending.cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses query settlement as the only cancellation fence', async () => {
    let rejectQuery!: (reason: Error) => void;
    const pending = Object.assign(
      new Promise<never[]>((_resolve, reject) => {
        rejectQuery = reject;
      }),
      {
        execute: vi.fn(),
        cancel: vi.fn(() => {
          rejectQuery(
            Object.assign(new Error('canceling statement due to user request'), { code: '57014' }),
          );
        }),
      },
    );
    const release = vi.fn();
    const unsafe = vi.fn(() => pending);
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
      expect(pending.execute).toHaveBeenCalledOnce();
    });

    controller.abort();
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
    expect(pending.cancel).toHaveBeenCalledOnce();
    expect(unsafe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
