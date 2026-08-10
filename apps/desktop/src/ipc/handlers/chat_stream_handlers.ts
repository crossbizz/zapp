import type { TextStreamPart, ToolSet } from "ai";

import { cleanFullResponse } from "@/ipc/utils/cleanFullResponse";
import { sanitizeMcpToolResult } from "@/ipc/utils/mcp_result_sanitizer";
import { isModelRefusal, MODEL_REFUSAL_WARNING } from "@/ipc/utils/model_refusal";
import { escapeXmlAttr, escapeXmlContent } from "../../../shared/xmlEscape";
import {
  blockNewStreamsForApp,
  blockNewStreamsForChat,
  cancelActiveStreamsForApp,
  cancelActiveStreamsForChat,
  getActiveStreamCount,
  registerZappLocalChatHandlers,
} from "@/zapp/runtime/local-chat-handlers";

export {
  blockNewStreamsForApp,
  blockNewStreamsForChat,
  cancelActiveStreamsForApp,
  cancelActiveStreamsForChat,
  getActiveStreamCount,
};

/** Compatibility name retained for test harnesses; production uses the zapp session loop. */
export const registerChatStreamHandlers = registerZappLocalChatHandlers;

const partialResponses = new Map<AbortController, string>();

export function addTrackedValue<T>(
  trackedValues: Map<number, Set<T>>,
  chatId: number,
  value: T,
): void {
  const values = trackedValues.get(chatId) ?? new Set<T>();
  values.add(value);
  trackedValues.set(chatId, values);
}

export function removeTrackedValue<T>(
  trackedValues: Map<number, Set<T>>,
  chatId: number,
  value: T,
): void {
  const values = trackedValues.get(chatId);
  values?.delete(value);
  if (values?.size === 0) trackedValues.delete(chatId);
}

export function setPartialResponseForStream(
  controller: AbortController,
  response: string,
): void {
  partialResponses.set(controller, response);
}

export function takePartialResponseForStream(controller: AbortController): string {
  const response = partialResponses.get(controller) ?? "";
  partialResponses.delete(controller);
  return response;
}

type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;

function parseMcpToolKey(toolKey: string): { serverName: string; toolName: string } {
  const index = toolKey.lastIndexOf("__");
  return index < 0
    ? { serverName: "", toolName: toolKey }
    : { serverName: toolKey.slice(0, index), toolName: toolKey.slice(index + 2) };
}

function escapeDyadTags(text: string): string {
  return text.replace(/<dyad-/gu, "＜dyad-");
}

export async function processStreamChunks(input: {
  fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>;
  fullResponse: string;
  abortController: AbortController;
  chatId: number;
  processResponseChunkUpdate: (params: { fullResponse: string }) => Promise<string>;
  includeReasoning?: boolean;
}): Promise<{
  fullResponse: string;
  incrementalResponse: string;
  modelRefused: boolean;
}> {
  const responseBeforeStream = input.fullResponse;
  let fullResponse = input.fullResponse;
  let incrementalResponse = "";
  let inThinkingBlock = false;
  let modelRefused = false;
  for await (const part of input.fullStream) {
    let chunk = "";
    if (
      inThinkingBlock &&
      !["reasoning-delta", "reasoning-end", "reasoning-start"].includes(part.type)
    ) {
      chunk = "</think>";
      inThinkingBlock = false;
    }
    if (isModelRefusal(part)) {
      fullResponse = responseBeforeStream;
      incrementalResponse = "";
      chunk = MODEL_REFUSAL_WARNING;
      modelRefused = true;
    } else if (part.type === "text-delta") {
      chunk += part.text;
    } else if (part.type === "reasoning-delta" && input.includeReasoning !== false) {
      if (!inThinkingBlock) {
        chunk = "<think>";
        inThinkingBlock = true;
      }
      chunk += escapeDyadTags(part.text);
    } else if (part.type === "tool-call") {
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      chunk = `<dyad-mcp-tool-call server="${escapeXmlAttr(serverName)}" tool="${escapeXmlAttr(toolName)}" call-id="${escapeXmlAttr(part.toolCallId)}">\n${escapeDyadTags(JSON.stringify(part.input))}\n</dyad-mcp-tool-call>\n`;
    } else if (part.type === "tool-result") {
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      chunk = `<dyad-mcp-tool-result server="${escapeXmlAttr(serverName)}" tool="${escapeXmlAttr(toolName)}" call-id="${escapeXmlAttr(part.toolCallId)}">\n${escapeXmlContent(part.output)}\n</dyad-mcp-tool-result>\n`;
    } else if (part.type === "tool-error") {
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      const message = part.error instanceof Error ? part.error.message : String(part.error);
      chunk = `<dyad-mcp-tool-result server="${escapeXmlAttr(serverName)}" tool="${escapeXmlAttr(toolName)}" call-id="${escapeXmlAttr(part.toolCallId)}" is-error="true">\n${escapeXmlContent(sanitizeMcpToolResult(message).serialized)}\n</dyad-mcp-tool-result>\n`;
    }
    if (chunk === "") continue;
    fullResponse = cleanFullResponse(fullResponse + chunk);
    incrementalResponse += chunk;
    fullResponse = await input.processResponseChunkUpdate({ fullResponse });
    if (input.abortController.signal.aborted || modelRefused) break;
  }
  return { fullResponse, incrementalResponse, modelRefused };
}

export function formatMessagesForSummary(
  values: { role: string; content: string | undefined }[],
): string {
  const messages =
    values.length <= 8
      ? values
      : [
          ...values.slice(0, 2),
          { role: "system", content: `[... ${values.length - 8} messages omitted ...]` },
          ...values.slice(-6),
        ];
  return messages
    .map((message) => `<message role="${message.role}">${message.content}</message>`)
    .join("\n");
}

export function removeProblemReportTags(text: string): string {
  return text
    .replace(/<dyad-problem-report[^>]*>[\s\S]*?<\/dyad-problem-report>/gu, "")
    .trim();
}

export function removeDyadTags(text: string): string {
  return text.replace(/<dyad-[^>]*>[\s\S]*?<\/dyad-[^>]*>/gu, "").trim();
}

export function hasUnclosedDyadWrite(text: string): boolean {
  const openings = [...text.matchAll(/<dyad-write[^>]*>/gu)];
  const lastOpening = openings.at(-1);
  return lastOpening !== undefined && !/<\/dyad-write>/u.test(text.slice(lastOpening.index));
}
