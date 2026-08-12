import { updateElectronApp, UpdateSourceType } from "update-electron-app";

export type ZappUpdateChannel = "stable" | "beta";

export interface ZappUpdaterLogger {
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

function staticFeedBase(
  feedOrigin: string,
  channel: ZappUpdateChannel,
): string | undefined {
  try {
    const parsed = new URL(feedOrigin.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return undefined;
    }
    const prefix = parsed.pathname.replace(/\/+$/u, "");
    parsed.pathname = `${prefix}/desktop-updates/${channel}`;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

/**
 * Starts Squirrel against zapp's HTTPS R2 feed.
 *
 * Squirrel/Electron performs platform code-signature verification before an
 * update can be installed. Static storage only chooses where the signed
 * release metadata and artifacts are fetched from.
 */
export function startZappUpdater(input: {
  readonly channel: ZappUpdateChannel;
  readonly feedOrigin: string;
  readonly logger: ZappUpdaterLogger;
}): boolean {
  const baseUrl = staticFeedBase(input.feedOrigin, input.channel);
  if (baseUrl === undefined) {
    input.logger.error("Auto-update disabled: invalid ZAPP_UPDATE_FEED.");
    return false;
  }

  try {
    updateElectronApp({
      logger: input.logger,
      notifyUser: true,
      updateInterval: "60 minutes",
      updateSource: {
        type: UpdateSourceType.StaticStorage,
        baseUrl,
      },
    });
    return true;
  } catch (error) {
    input.logger.error("Auto-update initialization failed.", error);
    return false;
  }
}
