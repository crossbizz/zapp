import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";

function getEditable(): Element {
  const editable = screen
    .getByTestId("chat-input-container")
    .querySelector('[contenteditable="true"]');
  if (editable === null) throw new Error("No chat input contenteditable found");
  return editable;
}

describe("queued messages (integration)", () => {
  let harness: HybridChatHarness;

  beforeAll(async () => {
    harness = await setupHybridChatHarness({
      electronMock: h,
      autoApprove: true,
      settings: { isTestMode: true },
    });
  }, 60_000);

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    await harness?.dispose();
  }, 60_000);

  it("restores, resaves, and clears queued attachments and selected components", async () => {
    const chatId = await harness.createChat();
    harness.mount({ chatId });
    const { send } = await harness.typeInChat("tc=local-agent/queue-delayed", {
      chatId,
    });
    send();
    await screen.findByRole("button", { name: /cancel generation/i });

    harness.setChatAttachments([
      {
        name: "queued-notes.txt",
        content: "important queued context",
        mimeType: "text/plain",
      },
    ]);
    harness.setSelectedComponents([
      {
        id: "component-hero",
        name: "HeroTitle",
        relativePath: "src/App.tsx",
        lineNumber: 1,
        columnNumber: 1,
      },
    ]);
    await screen.findByText("queued-notes.txt");
    await screen.findByTestId("selected-component-display");

    const queuedPrompt = "tc=local-agent/simple-response";
    await harness.pressEnterInChat(queuedPrompt, { chatId });
    const queueHeader = await screen.findByTestId("queue-header");
    await waitFor(() =>
      expect(queueHeader.textContent).toMatch(/^1\s+Queued/iu),
    );
    fireEvent.click(screen.getByRole("button", { name: /pause queue/i }));
    expect(screen.queryByText("queued-notes.txt")).toBeNull();
    expect(screen.queryByTestId("selected-component-display")).toBeNull();

    const queuedRow = within(queueHeader).getByText(queuedPrompt).closest("li");
    if (queuedRow === null) throw new Error("Queued message row is missing");
    fireEvent.click(within(queuedRow).getByTitle("Edit"));

    await waitFor(() =>
      expect(screen.getByTestId("chat-input-container").textContent).toContain(
        queuedPrompt,
      ),
    );
    await screen.findByText("queued-notes.txt");
    const selectedDisplay = await screen.findByTestId(
      "selected-component-display",
    );
    expect(selectedDisplay.textContent).toContain("HeroTitle");
    expect(selectedDisplay.textContent).toContain("src/App.tsx:1");

    fireEvent.keyDown(getEditable(), { key: "Enter", keyCode: 13 });
    await waitFor(() =>
      expect(screen.queryByText("queued-notes.txt")).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("selected-component-display")).toBeNull(),
    );
    expect(queueHeader.textContent).toMatch(/^1\s+Queued/iu);

    const resavedRow = within(queueHeader)
      .getByText(queuedPrompt)
      .closest("li");
    if (resavedRow === null) throw new Error("Resaved message row is missing");
    fireEvent.click(within(resavedRow).getByTitle("Delete"));
    await waitFor(() =>
      expect(screen.queryByTestId("queue-header")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /cancel generation/i }));
    await harness.waitForStreamEnd(chatId);
  }, 60_000);
});
