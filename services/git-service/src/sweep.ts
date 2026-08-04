import type { FastifyBaseLogger } from 'fastify';

import type { TokenService } from './tokens.js';

/**
 * The thing that makes "short-lived" true (plan 06 GIT-3, fix round 1).
 *
 * Forgejo has no expiring access token, so a repository-scoped credential stops
 * working when — and only when — something deletes the ephemeral user it belongs
 * to. `POST /internal/git/tokens/sweep` does that on demand; this runs it on a
 * timer, in the service itself.
 *
 * **Why in-process rather than an ops runbook item.** The first cut of GIT-3
 * shipped the route and wrote "ops must schedule this" in a README, which is a
 * property that holds only if somebody reads a README — and the review was
 * right to refuse it. The deployed instance has a *public* IPv4, a public IPv6
 * and a TLS certificate (`infra/terraform/forgejo.tf`), so an unswept token is
 * reachable from anywhere on the internet for as long as nobody sweeps. That is
 * precisely the exposure the 600-second ceiling exists to bound, and a bound
 * nothing enforces is not a bound.
 *
 * Three properties, and each is why this is ten lines rather than a scheduler:
 *
 *   - **Idempotent and cheap**, so N replicas all sweeping is not a problem to
 *     coordinate away — it is the redundancy the design was built for. The sweep
 *     reads a page of accounts and deletes only those whose deadline is in their
 *     own name; two replicas racing on one account produce a 404 for the loser,
 *     which `deleteUser` already allows.
 *   - **Unref'd**, so the timer never holds the process open. A container told to
 *     stop stops; it does not wait out an interval.
 *   - **Failure is logged, never thrown.** An unhandled rejection in a timer
 *     callback takes the process down, and a Git host that is briefly unreachable
 *     must not restart the service that talks to it. The next tick retries by
 *     construction.
 */

/**
 * How often to sweep, when nothing says otherwise.
 *
 * A minute. The shortest TTL a caller can ask for is one second and the longest
 * is ten minutes, so this bounds the overrun — the window between a token's
 * stated expiry and its actual death — at one minute rather than at "until
 * somebody notices". Shorter buys little: the tokens it would catch earlier are
 * ones whose whole lifetime is measured in minutes anyway.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export interface TokenSweepOptions {
  readonly tokens: TokenService;
  /** Where a failure goes. The app's logger, so it lands in the same stream as everything else. */
  readonly log: Pick<FastifyBaseLogger, 'error' | 'debug'>;
  /** Defaults to {@link DEFAULT_SWEEP_INTERVAL_MS}. */
  readonly intervalMs?: number;
}

export interface TokenSweep {
  /** Stops the timer. Called from the server's `onClose`. */
  stop(): void;
  /** Runs one sweep now, reporting failure through the logger rather than throwing. */
  runOnce(): Promise<void>;
}

export function scheduleTokenSweep(options: TokenSweepOptions): TokenSweep {
  const { tokens, log } = options;
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

  async function runOnce(): Promise<void> {
    try {
      const revoked = await tokens.sweepExpired();
      if (revoked > 0) {
        // Not `info` for a zero: a line every minute saying nothing happened is
        // a line nobody reads, and this one has to be noticed when it appears.
        log.debug({ revoked }, 'expired repository tokens revoked');
      }
    } catch (error) {
      log.error({ err: error }, 'the repository token sweep failed');
    }
  }

  const timer = setInterval(() => {
    // The promise is deliberately not awaited and deliberately cannot reject:
    // `runOnce` handles its own failure, so there is no unhandled rejection for
    // a timer callback to turn into a process exit.
    void runOnce();
  }, intervalMs);
  // Never the reason a process stays alive.
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
    runOnce,
  };
}
