import { createTypedHandler } from "@/ipc/handlers/base";
import { helpContracts } from "@/ipc/types/help";
import { safeSend } from "@/ipc/utils/safe_sender";

export function registerZappHelpBotHandlers(): void {
  createTypedHandler(helpContracts.start, async (event, { sessionId }) => {
    safeSend(event.sender, "help:chat:response:error", {
      sessionId,
      error: "Help chat is unavailable in this build.",
    });
    safeSend(event.sender, "help:chat:response:end", { sessionId });
    return { ok: true } as const;
  });
  createTypedHandler(helpContracts.cancel, async () => ({ ok: true }) as const);
}
