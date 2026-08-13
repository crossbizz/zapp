import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { chats } from "@/db/schema";
import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";

describe("plan mode (integration)", () => {
  let harness: HybridChatHarness;

  beforeAll(async () => {
    harness = await setupHybridChatHarness({
      electronMock: h,
      engine: true,
      settings: { isTestMode: true },
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  it("switches to the contained read-only plan mode", async () => {
    harness.mount();

    await harness.selectChatMode("plan");

    expect(
      await harness.db.query.chats.findFirst({
        where: eq(chats.id, harness.chatId),
      }),
    ).toMatchObject({ chatMode: "plan" });
    expect(
      harness.bridge.sentEvents.filter(
        (event) => event.channel === "chat:response:error",
      ),
    ).toHaveLength(0);
  }, 60_000);
});
