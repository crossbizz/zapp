import type { IpcMainInvokeEvent } from "electron";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { chats } from "@/db/schema";
import { readSettings } from "@/main/settings";
import {
  getCompactionThreshold,
  getContextWindow,
  shouldTriggerCompaction,
} from "@/ipc/utils/token_utils";

export interface CompactionResult {
  success: boolean;
  aborted?: boolean;
  skipped?: boolean;
  summary?: string;
  backupPath?: string;
  error?: string;
}

export async function markChatForCompaction(chatId: number): Promise<void> {
  await db
    .update(chats)
    .set({ pendingCompaction: true })
    .where(eq(chats.id, chatId));
}

export async function isChatPendingCompaction(
  chatId: number,
): Promise<boolean> {
  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, chatId),
    columns: { pendingCompaction: true },
  });
  return chat?.pendingCompaction === true;
}

export async function checkAndMarkForCompaction(
  chatId: number,
  totalTokens: number,
): Promise<boolean> {
  const settings = readSettings();
  if (settings.enableContextCompaction === false) return false;
  const contextWindow = await getContextWindow();
  const provider = settings.selectedModel.provider;
  if (!shouldTriggerCompaction(totalTokens, contextWindow, provider))
    return false;
  await markChatForCompaction(chatId);
  return true;
}

/**
 * Local conversations are compacted by the packaged AR-6 session transcript.
 * The legacy Dyad model compactor remains as a visible, fail-closed boundary.
 */
export async function performCompaction(
  _event: IpcMainInvokeEvent,
  chatId: number,
  _appPath: string,
  _dyadRequestId: string,
  _onSummaryChunk?: (accumulatedText: string) => void,
  options?: {
    createdAtStrategy?: "before-latest-user" | "now";
    abortSignal?: AbortSignal;
  },
): Promise<CompactionResult> {
  if (options?.abortSignal?.aborted === true) {
    return { success: false, aborted: true, error: "Compaction aborted" };
  }
  if (!(await isChatPendingCompaction(chatId))) {
    return { success: true, skipped: true };
  }
  return {
    success: false,
    skipped: true,
    error:
      "Legacy provider compaction is disabled; the local session transcript owns context.",
  };
}

export { getCompactionThreshold };
