// Migrated from e2e-tests/local_agent_ask.spec.ts, then converted from the
// node chat-flow harness to the HYBRID harness (real <ChatPanel> over the real
// IPC stack).
//
// Ask mode uses the same public CompleteRequest boundary as build mode but is
// structurally limited to contained read tools.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cleanup, screen, waitFor } from "@testing-library/react";

import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";
import { messages as messagesTable } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

describe("local-agent ask mode (integration)", () => {
  let harness: HybridChatHarness;

  beforeAll(async () => {
    harness = await setupHybridChatHarness({
      electronMock: h,
      engine: true,
      chatMode: "ask",
      settings: {
        isTestMode: true,
        enableDyadPro: true,
        providerSettings: { auto: { apiKey: { value: "testdyadkey" } } },
        enableCodeExplorer: false,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  afterEach(() => {
    cleanup();
  });

  it("reads App.tsx through the contained read_file tool", async () => {
    harness.mount();
    await waitFor(
      () => {
        expect(screen.getByTestId("messages-list")).toBeTruthy();
        expect(screen.getByTestId("chat-input-container")).toBeTruthy();
      },
      { timeout: 15_000 },
    );

    // Select Ask mode through the REAL chat-mode selector (persists
    // chatMode="ask" onto the chat row). Without this the submit would fall
    // back to the Pro default mode (local-agent) — `chatMode: "ask"` on the
    // harness only seeds settings.selectedChatMode, which per-chat submits
    // don't read for existing chats.
    await harness.selectChatMode("ask");

    const { send } = await harness.typeInChat(
      "tc=local-agent/ask-contained-read",
    );
    send();

    await waitFor(
      () =>
        expect(
          screen.getByText(
            /This is a simple React component that renders the Minimal imported app text/,
          ),
        ).toBeTruthy(),
      { timeout: 20_000 },
    );

    // Gate main-side (db) assertions on the real end-of-stream event.
    await harness.waitForStreamEnd(harness.chatId);
    expect(
      harness.bridge.sentEvents.filter(
        (e) => e.channel === "chat:response:error",
      ),
    ).toHaveLength(0);

    const messages = await harness.db.query.messages.findMany({
      where: eq(messagesTable.chatId, harness.chatId),
      orderBy: [asc(messagesTable.id)],
    });
    const assistant = messages[messages.length - 1];
    expect(assistant.role).toBe("assistant");
    const content = assistant.content;
    expect(content).toContain(
      "This is a simple React component that renders the Minimal imported app text.",
    );
    const toolResultRequest = harness.capturedCompletions().at(-1);
    const toolMessage = toolResultRequest?.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.role).toBe("tool");
    expect(toolMessage?.content[0]).toMatchObject({
      type: "tool-result",
      toolName: "read_file",
    });
    expect(JSON.stringify(toolMessage)).toContain("Minimal imported app");

    // Every channel the UI invoked had a real handler.
    expect([...harness.bridge.missingChannels]).toEqual([]);
  }, 60_000);

  it("provides only read-only tools in the request payload", async () => {
    // Fresh chat (mirrors the e2e clicking New Chat) so the dump excludes the
    // sandbox tool result with its nondeterministic execution timing.
    const chatId = await harness.createChat();

    harness.mount({ chatId });
    await waitFor(
      () => {
        expect(screen.getByTestId("messages-list")).toBeTruthy();
        expect(screen.getByTestId("chat-input-container")).toBeTruthy();
      },
      { timeout: 15_000 },
    );

    // Select Ask mode through the REAL chat-mode selector for this fresh chat
    // (see note in the previous test).
    await harness.selectChatMode("ask");

    // Baseline-aware end gate: the previous it already produced
    // chat:response:end events on this bridge.
    const streamEnd = harness.waitForNextStreamEnd(chatId);
    const { send } = await harness.typeInChat(
      "tc=local-agent/simple-response",
      { chatId },
    );
    send();

    await streamEnd;
    expect(
      harness.bridge.sentEvents.filter(
        (e) => e.channel === "chat:response:error",
      ),
    ).toHaveLength(0);

    const request = harness.capturedCompletions().at(-1);
    expect(request?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
    ]);

    // Every channel the UI invoked had a real handler.
    expect([...harness.bridge.missingChannels]).toEqual([]);
  }, 60_000);
});
