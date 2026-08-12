// zapp: the auto-update source for this fork (MAC-2).
//
// Upstream starts `update-electron-app` against Dyad's own service
// (`https://api.dyad.sh/v1/update/{stable,beta}`, repo `dyad-sh/dyad`). Carried
// over unchanged, a distributed zapp build would poll Dyad's server and could
// install **Dyad over zapp**, while also leaking zapp's install base to them.
//
// **MAC-11 owns the real zapp feed** (Squirrel auto-update, R2-hosted). Until it
// exists there is no correct URL to point at, so the updater does not start at
// all: it runs only when `ZAPP_UPDATE_FEED` names a feed base, and the repo
// defaults to this fork's own. There is no path back to a Dyad URL.
//
//   ZAPP_UPDATE_FEED=https://updates.zapp.build   R2 origin/base, required
//
// The extraction out of `src/main.ts` is deliberate: main.ts cannot be imported
// by a unit test (electron, the database and ~50 modules load at import time),
// and this behaviour is exactly the kind that must be pinned by one.

import type { UserSettings } from "@/lib/schemas";
import { startZappUpdater } from "./updater/start";

// Structurally `update-electron-app`'s ILogger — electron-log satisfies it.
interface AutoUpdateLogger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Start the auto-updater if a zapp update feed is configured.
 *
 * @returns whether an updater was started.
 */
export function startAutoUpdate({
  settings,
  logger,
}: {
  settings: UserSettings;
  logger: AutoUpdateLogger;
}): boolean {
  const feed = process.env.ZAPP_UPDATE_FEED?.trim();
  if (!feed) {
    logger.info("Auto-update skipped: ZAPP_UPDATE_FEED is not set.");
    return false;
  }

  const channel = settings.releaseChannel === "beta" ? "beta" : "stable";
  logger.info("Auto-update release channel=", channel);
  return startZappUpdater({
    channel,
    feedOrigin: feed,
    logger,
  });
}
