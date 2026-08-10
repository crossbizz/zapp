import { createTypedHandler } from "@/ipc/handlers/base";

import { platformAuthContracts } from "./contracts";
import type { PlatformAuthSession } from "./session";

export function registerPlatformAuthHandlers(
  session: PlatformAuthSession,
  publishState: (
    state: ReturnType<PlatformAuthSession["snapshot"]>,
  ) => void = () => {},
): () => void {
  createTypedHandler(platformAuthContracts.snapshot, async () =>
    session.snapshot(),
  );
  createTypedHandler(platformAuthContracts.signIn, async () =>
    session.signIn(),
  );
  createTypedHandler(platformAuthContracts.signOut, async () => {
    await session.signOut();
    return session.snapshot();
  });
  createTypedHandler(
    platformAuthContracts.selectOrganization,
    async (_event, { organizationId }) =>
      await session.selectOrganization(organizationId),
  );
  return session.subscribe(publishState);
}
