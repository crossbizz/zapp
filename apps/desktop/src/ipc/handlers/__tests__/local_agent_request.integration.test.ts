// The hybrid gateway captures the public CompleteRequest after Zod validation.
// This proves the UI/main-process composition sends only the contained local
// workspace tools; it intentionally does not snapshot removed provider-private
// headers or the legacy Pro tool surface.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { screen, waitFor } from "@testing-library/react";

import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";

describe("local-agent default request (integration)", () => {
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
        // Matches the e2e: with the code explorer off the request carries
        // `code_search` (not `explore_code`), keeping the tool list stable.
        enableCodeExplorer: false,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  it("sends the contained build-mode tool list through CompleteRequest", async () => {
    harness.mount();
    await waitFor(
      () => {
        expect(screen.getByTestId("messages-list")).toBeTruthy();
        expect(screen.getByTestId("chat-input-container")).toBeTruthy();
      },
      { timeout: 15_000 },
    );

    // Drive the real chat-mode selector so the chat row persists local-agent
    // mode (see the note in local_agent_ask.integration.test.ts).
    await harness.selectChatMode("local-agent");

    const streamEnd = harness.waitForNextStreamEnd(harness.chatId);
    const { send } = await harness.typeInChat("tc=local-agent/simple-response");
    send();
    await streamEnd;
    expect(
      harness.bridge.sentEvents.filter(
        (e) => e.channel === "chat:response:error",
      ),
    ).toHaveLength(0);

    const request = harness.capturedCompletions().at(-1);
    expect(request).toBeDefined();
    expect(request?.agentRole).toBe("builder");
    expect(request?.tools?.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
      "write_file",
      "apply_patch",
      "copy_file",
      "rename_file",
      "delete_file",
    ]);
    const systemMessage = request?.messages.find(
      (message) => message.role === "system",
    );
    const systemText =
      systemMessage?.role === "system" ? systemMessage.content : "";
    expect(systemText).toContain(
      "You are the zapp local builder. Inspect the project, use only the provided tools",
    );

    // Every channel the UI invoked had a real handler.
    expect([...harness.bridge.missingChannels]).toEqual([]);
  }, 60_000);
});
