import log from "electron-log";

import type { StreamingPatch } from "@/ipc/types";
import { hashPrefix } from "@/lib/prefixHash";

const logger = log.scope("stream_text_utils");

export function fastTextOutput() {
  return {
    name: "text" as const,
    responseFormat: Promise.resolve({ type: "text" as const }),
    async parsePartialOutput({ text }: { text: string }) {
      return { partial: text.length };
    },
    async parseCompleteOutput({ text }: { text: string }) {
      return text;
    },
    createElementStreamTransform() {
      return undefined;
    },
  };
}

export function computeStreamingPatch(
  fullResponse: string,
  lastSentContent: string,
): StreamingPatch | null {
  if (fullResponse === lastSentContent) return null;
  let offset = 0;
  const limit = Math.min(lastSentContent.length, fullResponse.length);
  while (
    offset < limit &&
    lastSentContent.charCodeAt(offset) === fullResponse.charCodeAt(offset)
  ) {
    offset += 1;
  }
  return {
    offset,
    content: fullResponse.slice(offset),
    prefixHash: offset > 0 ? hashPrefix(fullResponse, offset) : undefined,
  };
}

export function cancelOrphanedBaseStream(streamResult: unknown): void {
  const orphan = streamResult as {
    baseStream?: { cancel?: () => Promise<unknown> | undefined };
  };
  try {
    const cancellation = orphan.baseStream?.cancel?.();
    void cancellation?.catch((error: unknown) => {
      logger.warn("Failed to cancel orphaned stream branch", error);
    });
  } catch (error) {
    logger.warn("Failed to cancel orphaned stream branch", error);
  }
}
