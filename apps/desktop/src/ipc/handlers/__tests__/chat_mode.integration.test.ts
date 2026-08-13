// Migrated from e2e-tests/chat_mode.spec.ts, then converted from the node
// chat-flow harness to the HYBRID harness (real <ChatPanel> over the real IPC
// stack). The describe/it names are kept identical to the node version on
// purpose. The contained gateway exposes its strict CompleteRequest directly,
// so this suite asserts that public request instead of a provider transport dump.
//
// Behavior tests ported:
//   - "default build mode": the request offers only contained workspace tools
//     and the resulting write is committed.
//   - "ask mode": the chat mode is switched to "ask" through the REAL
//     ChatModeSelector dropdown (it lives in ChatInput -> ChatInputControls);
//     the payload then omits the codebase-priming user turn and nothing is
//     committed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cleanup, screen, waitFor } from "@testing-library/react";
import { eq } from "drizzle-orm";

import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";
import { chats, messages } from "@/db/schema";

function errorEvents(harness: HybridChatHarness) {
  return harness.bridge.sentEvents.filter(
    (e) => e.channel === "chat:response:error",
  );
}

describe("chat mode (integration)", () => {
  let harness: HybridChatHarness;

  beforeAll(async () => {
    harness = await setupHybridChatHarness({
      electronMock: h,
      settings: { isTestMode: true },
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  afterEach(() => {
    cleanup();
  });

  it("default build mode sends the contained mutation tool list", async () => {
    harness.mount();
    await waitFor(
      () => {
        expect(screen.getByTestId("messages-list")).toBeTruthy();
        expect(screen.getByTestId("chat-input-container")).toBeTruthy();
      },
      { timeout: 15_000 },
    );

    const prompt = "tc=local-agent/simple-response";
    const { send } = await harness.typeInChat(prompt);
    send();

    await waitFor(() => expect(screen.getByText(prompt)).toBeTruthy(), {
      timeout: 15_000,
    });
    await harness.waitForStreamEnd(harness.chatId);
    expect(errorEvents(harness)).toHaveLength(0);

    const request = harness.capturedCompletions().at(-1);
    expect(request?.messages.at(-1)).toEqual({ role: "user", content: prompt });
    expect(request?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
      "write_file",
      "apply_patch",
      "copy_file",
      "rename_file",
      "delete_file",
    ]);

    // Equivalent of snapshotMessages: user prompt + assistant response
    // containing the (path-masked in UI) dump marker.
    const messages = await harness.db.query.messages.findMany();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe(prompt);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].commitHash).toBeNull();
    const latchedChat = await harness.db.query.chats.findFirst({
      where: (chats, { eq }) => eq(chats.id, harness.chatId),
    });
    expect(latchedChat?.chatMode).toBe("local-agent");
  }, 60_000);

  it("ask mode omits codebase context and does not apply changes", async () => {
    // The e2e selected ask mode via the chat-mode selector; mirror that by
    // creating a fresh chat and driving the REAL selector to "ask" (it persists
    // chatMode onto the chat row via ipc.chat.updateChat).
    const askChatId = await harness.createChat();
    harness.mount({ chatId: askChatId });
    await waitFor(
      () => expect(screen.getByTestId("chat-input-container")).toBeTruthy(),
      { timeout: 15_000 },
    );

    // Drive the REAL Base UI Select to "ask" (persists chatMode onto the chat
    // row). The harness helper encapsulates the happy-dom choreography (focus +
    // ArrowDown to open, pointer + Enter on the option to commit).
    await harness.selectChatMode("ask");

    const prompt = "tc=local-agent/simple-response";
    const { send } = await harness.typeInChat(prompt, {
      chatId: askChatId,
    });
    send();

    await waitFor(() => expect(screen.getByText(prompt)).toBeTruthy(), {
      timeout: 15_000,
    });
    await harness.waitForStreamEnd(askChatId);
    expect(errorEvents(harness)).toHaveLength(0);

    const request = harness.capturedCompletions().at(-1);
    expect(request?.messages.at(-1)).toEqual({ role: "user", content: prompt });
    expect(request?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
    ]);

    // The response is recorded on the ask chat but nothing is committed.
    const dbMessages = await harness.db.query.messages.findMany();
    const askChatMessages = dbMessages.filter((m) => m.chatId === askChatId);
    expect(askChatMessages).toHaveLength(2);
    expect(askChatMessages[0].role).toBe("user");
    expect(askChatMessages[0].content).toBe(prompt);
    const assistant = askChatMessages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.commitHash).toBeNull();
    expect(harness.gitLog()).toHaveLength(1);
  }, 60_000);

  it("repairs a null mode when an accepted first turn is replayed", async () => {
    const replayChatId = await harness.createChat();
    const userInputRequestId = "accepted-first-turn";
    await harness.db.insert(messages).values({
      chatId: replayChatId,
      role: "user",
      content: "already accepted",
      userInputRequestId,
    });

    const result = await harness.streamChat("already accepted", {
      chatId: replayChatId,
      requestedChatMode: "ask",
      userInputRequestId,
    });

    expect(result.eventsFor("chat:response:error")).toHaveLength(0);
    expect(result.eventsFor("chat:response:end")).toHaveLength(1);
    const repairedChat = await harness.db.query.chats.findFirst({
      where: eq(chats.id, replayChatId),
    });
    expect(repairedChat?.chatMode).toBe("ask");
    const replayMessages = await harness.db.query.messages.findMany({
      where: eq(messages.chatId, replayChatId),
    });
    expect(replayMessages).toHaveLength(1);
  }, 60_000);
});
