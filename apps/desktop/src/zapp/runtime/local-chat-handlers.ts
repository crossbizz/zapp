import { randomUUID } from "node:crypto";

import { app, type IpcMainInvokeEvent, type WebContents } from "electron";
import { and, desc, eq } from "drizzle-orm";

import type {
  ChatStreamChunkPayload,
  ChatStreamEndPayload,
  ChatStreamErrorPayload,
  ChatStreamStartPayload,
  ChatStreamTransportEndPayload,
} from "@/chat_stream/protocol";
import { db } from "@/db";
import { chats, messages } from "@/db/schema";
import { DyadError, DyadErrorKind, isDyadError } from "@/errors/dyad_error";
import { createTypedHandler } from "@/ipc/handlers/base";
import { acceptChatTurn } from "@/ipc/handlers/chat_turn_acceptance";
import { registerTrustedIpcHandler } from "@/ipc/handlers/trusted_handle";
import { chatContracts, ChatStreamParamsSchema } from "@/ipc/types/chat";
import type { ChatStreamParams } from "@/ipc/types";
import { safeSend } from "@/ipc/utils/safe_sender";
import { normalizeStoredChatMode } from "@/lib/chatMode";
import type { ChatMode } from "@/lib/schemas";
import { appendCancelledResponseNotice } from "@/shared/chatCancellation";
import {
  handleLocalAgentStream,
  clearPendingLocalAgentInputsForChat,
} from "@/zapp/pro_stubs/main";

interface ActiveStream {
  readonly appId: number;
  readonly abort: AbortController;
  readonly completion: Promise<void>;
  readonly resolveCompletion: () => void;
  readonly streamId?: number;
}

const activeStreams = new Map<number, Set<ActiveStream>>();
const chatBlocks = new Map<number, number>();
const appBlocks = new Map<number, number>();
const chatWaiters = new Map<number, Set<() => void>>();
const appWaiters = new Map<number, Set<() => void>>();

function incrementBlock(
  blocks: Map<number, number>,
  waiters: Map<number, Set<() => void>>,
  key: number,
): () => void {
  blocks.set(key, (blocks.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (blocks.get(key) ?? 1) - 1;
    if (remaining > 0) {
      blocks.set(key, remaining);
      return;
    }
    blocks.delete(key);
    const pending = waiters.get(key);
    waiters.delete(key);
    pending?.forEach((resolve) => {
      resolve();
    });
  };
}

async function waitForBlock(
  blocks: Map<number, number>,
  waiters: Map<number, Set<() => void>>,
  key: number,
  signal: AbortSignal,
): Promise<boolean> {
  while ((blocks.get(key) ?? 0) > 0) {
    if (signal.aborted) return false;
    await new Promise<void>((resolve) => {
      const pending = waiters.get(key) ?? new Set<() => void>();
      const onAbort = () => {
        pending.delete(onRelease);
        resolve();
      };
      const onRelease = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      pending.add(onRelease);
      waiters.set(key, pending);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  return !signal.aborted;
}

function addActive(chatId: number, stream: ActiveStream): void {
  const streams = activeStreams.get(chatId) ?? new Set<ActiveStream>();
  streams.add(stream);
  activeStreams.set(chatId, streams);
}

function removeActive(chatId: number, stream: ActiveStream): void {
  const streams = activeStreams.get(chatId);
  if (streams === undefined) return;
  streams.delete(stream);
  if (streams.size === 0) activeStreams.delete(chatId);
}

function selectedMode(
  request: ChatStreamParams,
  storedMode: string | null,
): ChatMode {
  return (
    request.requestedChatMode ??
    normalizeStoredChatMode(storedMode) ??
    "local-agent"
  );
}

function sendCancelled(
  sender: WebContents,
  chatId: number,
  stream: ActiveStream,
): void {
  safeSend(sender, "chat:response:end", {
    chatId,
    streamId: stream.streamId,
    updatedFiles: false,
    wasCancelled: true,
  } satisfies ChatStreamEndPayload);
  safeSend(sender, "chat:stream:end", {
    chatId,
  } satisfies ChatStreamTransportEndPayload);
}

async function cancelStreams(
  entries: readonly { chatId: number; stream: ActiveStream }[],
  sender: WebContents,
): Promise<boolean> {
  if (entries.length === 0) return false;
  for (const { chatId, stream } of entries) {
    stream.abort.abort();
    clearPendingLocalAgentInputsForChat(chatId);
    sendCancelled(sender, chatId, stream);
  }
  await Promise.all(entries.map(async ({ stream }) => await stream.completion));
  for (const chatId of new Set(entries.map((entry) => entry.chatId))) {
    const [latestAssistant] = await db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(and(eq(messages.chatId, chatId), eq(messages.role, "assistant")))
      .orderBy(desc(messages.id))
      .limit(1);
    if (latestAssistant !== undefined) {
      await db
        .update(messages)
        .set({
          content: appendCancelledResponseNotice(latestAssistant.content),
        })
        .where(eq(messages.id, latestAssistant.id));
    }
  }
  return true;
}

export function getActiveStreamCount(): number {
  return activeStreams.size;
}

export function blockNewStreamsForChat(chatId: number): () => void {
  return incrementBlock(chatBlocks, chatWaiters, chatId);
}

export function blockNewStreamsForApp(appId: number): () => void {
  return incrementBlock(appBlocks, appWaiters, appId);
}

export async function cancelActiveStreamsForChat(
  chatId: number,
  sender: WebContents,
): Promise<boolean> {
  return await cancelStreams(
    [...(activeStreams.get(chatId) ?? [])].map((stream) => ({
      chatId,
      stream,
    })),
    sender,
  );
}

export async function cancelActiveStreamsForApp(
  appId: number,
  sender: WebContents,
): Promise<boolean> {
  const entries = [...activeStreams].flatMap(([chatId, streams]) =>
    [...streams]
      .filter((stream) => stream.appId === appId)
      .map((stream) => ({ chatId, stream })),
  );
  return await cancelStreams(entries, sender);
}

async function runLocalChatStream(
  event: IpcMainInvokeEvent,
  rawRequest: ChatStreamParams,
): Promise<number | "error"> {
  const request = ChatStreamParamsSchema.parse(rawRequest);
  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, request.chatId),
    columns: { id: true, appId: true, chatMode: true },
  });
  if (chat === undefined) {
    throw new DyadError(
      `Chat not found: ${request.chatId}`,
      DyadErrorKind.NotFound,
    );
  }

  const abort = new AbortController();
  let resolveCompletion = () => {};
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const active: ActiveStream = {
    appId: chat.appId,
    abort,
    completion,
    resolveCompletion,
    streamId: request.streamId,
  };
  addActive(request.chatId, active);

  try {
    if (
      !(await waitForBlock(
        chatBlocks,
        chatWaiters,
        request.chatId,
        abort.signal,
      ))
    ) {
      return request.chatId;
    }
    if (
      !(await waitForBlock(appBlocks, appWaiters, chat.appId, abort.signal))
    ) {
      return request.chatId;
    }
    safeSend(event.sender, "chat:stream:start", {
      chatId: request.chatId,
      streamId: request.streamId,
    } satisfies ChatStreamStartPayload);

    if ((request.attachments?.length ?? 0) > 0) {
      throw new DyadError(
        "Attachments are not available in local mode yet.",
        DyadErrorKind.Precondition,
      );
    }
    const mode = selectedMode(request, chat.chatMode);
    const accepted = acceptChatTurn(db, {
      chatId: request.chatId,
      storedChatMode: chat.chatMode,
      selectedChatMode: mode,
      content: request.prompt,
      userInputRequestId: request.userInputRequestId,
      redo: request.redo,
    });
    if (request.userInputRequestId !== undefined) {
      safeSend(event.sender, "chat:response:chunk", {
        chatId: request.chatId,
        streamId: request.streamId,
        acceptedUserInputRequestId: request.userInputRequestId,
      } satisfies ChatStreamChunkPayload);
    }
    if (accepted.userMessageId === null) {
      safeSend(event.sender, "chat:response:end", {
        chatId: request.chatId,
        streamId: request.streamId,
        updatedFiles: false,
      } satisfies ChatStreamEndPayload);
      return request.chatId;
    }
    safeSend(event.sender, "chat:response:chunk", {
      chatId: request.chatId,
      streamId: request.streamId,
      effectiveChatMode: mode,
    } satisfies ChatStreamChunkPayload);

    const [placeholder] = await db
      .insert(messages)
      .values({
        chatId: request.chatId,
        role: "assistant",
        content: "",
        requestId: randomUUID(),
        model: "zapp-platform",
      })
      .returning({ id: messages.id });
    if (placeholder === undefined)
      throw new Error("Could not create the assistant response.");

    await handleLocalAgentStream(event, request, abort, {
      placeholderMessageId: placeholder.id,
      acceptedUserMessageId: accepted.userMessageId,
      systemPrompt:
        "You are the zapp local builder. Inspect the project, use only the provided tools, and make the requested change safely.",
      dyadRequestId: randomUUID(),
      readOnly: mode === "ask",
      planModeOnly: mode === "plan",
    });
    return request.chatId;
  } catch (error) {
    if (!abort.signal.aborted) {
      safeSend(event.sender, "chat:response:error", {
        chatId: request.chatId,
        streamId: request.streamId,
        error: isDyadError(error)
          ? error.message
          : "The local agent could not complete this request.",
      } satisfies ChatStreamErrorPayload);
      safeSend(event.sender, "chat:response:end", {
        chatId: request.chatId,
        streamId: request.streamId,
        updatedFiles: false,
      } satisfies ChatStreamEndPayload);
    }
    return "error";
  } finally {
    removeActive(request.chatId, active);
    active.resolveCompletion();
    if (!abort.signal.aborted) {
      safeSend(event.sender, "chat:stream:end", {
        chatId: request.chatId,
      } satisfies ChatStreamTransportEndPayload);
    }
  }
}

export function registerZappLocalChatHandlers(): void {
  app?.on?.("before-quit", () => {
    for (const streams of activeStreams.values()) {
      for (const stream of streams) stream.abort.abort();
    }
  });
  createTypedHandler(chatContracts.responseAck, async () => undefined);
  createTypedHandler(chatContracts.cancelStream, async (event, chatId) => {
    await cancelActiveStreamsForChat(chatId, event.sender);
    return true;
  });
  registerTrustedIpcHandler("chat:stream", runLocalChatStream);
}
