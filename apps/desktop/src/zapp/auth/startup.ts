import type { PlatformAuthSession, PlatformAuthState } from "./session";

export interface PlatformAuthStartup {
  readonly state: PlatformAuthState;
  readonly background: Promise<PlatformAuthState>;
}

export async function restorePlatformAuthForStartup(
  session: PlatformAuthSession,
): Promise<PlatformAuthStartup> {
  const state = await session.restoreCached();
  return {
    state,
    background: session.refresh(),
  };
}
