// Migrated from e2e-tests/local_agent_list_files.spec.ts, then converted from
// the node chat-flow harness to the HYBRID harness (real <ChatPanel> over the
// real IPC stack).
//
// Exercises the local-agent (Agent v2) list_files tool through the real
// chat:stream handler: the fake LLM streams tool calls from the
// e2e-tests/fixtures/engine/local-agent/*.ts fixtures, the real tool executes
// against the checked-out fixture app. The second public CompleteRequest
// contains the typed tool result, which is the current renderer-independent
// contract; the retired Pro XML card is deliberately not asserted here.
//
// Dyad Pro engine/gateway calls are routed to the harness fake server via
// `engine: true`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { screen, waitFor } from "@testing-library/react";

import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";
import { apps, chats, messages as messagesTable } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

describe("local-agent list_files (integration)", () => {
  let harness: HybridChatHarness;

  beforeAll(async () => {
    harness = await setupHybridChatHarness({
      electronMock: h,
      engine: true,
      chatMode: "local-agent",
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

  it("lists files non-recursively then recursively", async () => {
    harness.mount();
    await waitFor(
      () => {
        expect(screen.getByTestId("messages-list")).toBeTruthy();
        expect(screen.getByTestId("chat-input-container")).toBeTruthy();
      },
      { timeout: 15_000 },
    );

    // First turn: non-recursive listing.
    const { send } = await harness.typeInChat(
      "tc=local-agent/list-files-non-recursive",
    );
    send();

    await waitFor(
      () =>
        expect(
          screen.getByText(/Here are the files in the src directory\./),
        ).toBeTruthy(),
      { timeout: 20_000 },
    );

    await harness.waitForStreamEnd(harness.chatId);
    // Note: the local-agent branch of chat:stream returns undefined (not the
    // chatId), so success is asserted via the absence of error events.
    expect(
      harness.bridge.sentEvents.filter(
        (e) => e.channel === "chat:response:error",
      ),
    ).toHaveLength(0);

    const firstMessages = await harness.db.query.messages.findMany({
      where: eq(messagesTable.chatId, harness.chatId),
      orderBy: [asc(messagesTable.id)],
    });
    const firstAssistant = firstMessages[firstMessages.length - 1];
    expect(firstAssistant.role).toBe("assistant");
    expect(firstAssistant.content).toContain(
      "Here are the files in the src directory.",
    );
    const nonRecursiveToolMessage = harness
      .capturedCompletions()
      .at(-1)
      ?.messages.find((message) => message.role === "tool");
    expect(nonRecursiveToolMessage?.role).toBe("tool");
    expect(nonRecursiveToolMessage?.content[0]).toMatchObject({
      type: "tool-result",
      toolName: "list_files",
    });
    expect(JSON.stringify(nonRecursiveToolMessage)).toContain("App.tsx");
    expect(JSON.stringify(nonRecursiveToolMessage)).toContain("main.tsx");

    // Second turn: recursive listing. Baseline-aware end gate (turn 2 in the
    // same chat — plain waitForStreamEnd would match turn 1's stale event).
    const secondEnd = harness.waitForNextStreamEnd(harness.chatId);
    const { send: sendSecond } = await harness.typeInChat(
      "tc=local-agent/list-files-recursive",
    );
    sendSecond();

    await secondEnd;
    expect(
      harness.bridge.sentEvents.filter(
        (e) => e.channel === "chat:response:error",
      ),
    ).toHaveLength(0);

    const secondMessages = await harness.db.query.messages.findMany({
      where: eq(messagesTable.chatId, harness.chatId),
      orderBy: [asc(messagesTable.id)],
    });
    const secondAssistant = secondMessages[secondMessages.length - 1];
    expect(secondAssistant.role).toBe("assistant");
    expect(secondAssistant.content).toContain(
      "Here are all the files in the src directory and its subdirectories.",
    );
    const recursiveToolMessage = harness
      .capturedCompletions()
      .at(-1)
      ?.messages.find((message) => message.role === "tool");
    expect(recursiveToolMessage?.role).toBe("tool");
    expect(recursiveToolMessage?.content[0]).toMatchObject({
      type: "tool-result",
      toolName: "list_files",
    });
    expect(JSON.stringify(recursiveToolMessage)).toContain("App.tsx");
    expect(JSON.stringify(recursiveToolMessage)).toContain("main.tsx");

    // Every channel the UI invoked had a real handler.
    expect([...harness.bridge.missingChannels]).toEqual([]);
  }, 60_000);

  it("does not expose ignored files", async () => {
    // The e2e used the minimal-with-dyad fixture app (it has a git-ignored
    // .dyad/plans/test-plan.md). Check it out as a second app in this
    // harness's temp root and run the fixture in its own chat.
    const fixtureAppDir = path.join(
      process.cwd(),
      "e2e-tests",
      "fixtures",
      "import-app",
      "minimal-with-dyad",
    );
    const appDir = path.join(path.dirname(harness.appDir), "app-with-dyad");
    fs.cpSync(fixtureAppDir, appDir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.email=test@example.com",
          "-c",
          "user.name=Test User",
          ...args,
        ],
        { cwd: appDir, stdio: "pipe" },
      );
    git("init");
    git("add", "-A");
    git("commit", "-m", "init");

    const [appRow] = await harness.db
      .insert(apps)
      .values({ name: "minimal-with-dyad", path: appDir })
      .returning();
    const [chatRow] = await harness.db
      .insert(chats)
      .values({ appId: appRow.id })
      .returning();

    harness.mount({ chatId: chatRow.id, appId: appRow.id });
    await waitFor(
      () => {
        expect(screen.getByTestId("messages-list")).toBeTruthy();
        expect(screen.getByTestId("chat-input-container")).toBeTruthy();
      },
      { timeout: 15_000 },
    );

    // Baseline-aware end gate: the previous it already produced
    // chat:response:end events on this bridge.
    const streamEnd = harness.waitForNextStreamEnd(chatRow.id);
    const { send } = await harness.typeInChat(
      "tc=local-agent/list-files-include-ignored",
      { chatId: chatRow.id },
    );
    send();

    await waitFor(
      () =>
        expect(
          screen.getByText(
            /No ignored \.dyad files are visible to the model\./,
          ),
        ).toBeTruthy(),
      { timeout: 20_000 },
    );

    await streamEnd;
    expect(
      harness.bridge.sentEvents.filter(
        (e) => e.channel === "chat:response:error",
      ),
    ).toHaveLength(0);

    // Read this chat's rows directly.
    const chatMessages = await harness.db.query.messages.findMany({
      where: eq(messagesTable.chatId, chatRow.id),
      orderBy: [asc(messagesTable.id)],
    });
    const assistant = chatMessages[chatMessages.length - 1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toContain(
      "No ignored .dyad files are visible to the model.",
    );
    const ignoredToolMessage = harness
      .capturedCompletions()
      .at(-1)
      ?.messages.find((message) => message.role === "tool");
    expect(ignoredToolMessage?.role).toBe("tool");
    expect(ignoredToolMessage?.content[0]).toMatchObject({
      type: "tool-result",
      toolName: "list_files",
    });
    expect(JSON.stringify(ignoredToolMessage)).not.toContain(
      ".dyad/plans/test-plan.md",
    );

    // Every channel the UI invoked had a real handler.
    expect([...harness.bridge.missingChannels]).toEqual([]);
  }, 60_000);
});
