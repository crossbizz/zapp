import { describe, expect, test, vi } from "vitest";

import { DyadErrorKind } from "@/errors/dyad_error";
import type { UserSettings } from "@/lib/schemas";

import {
  createDyadEngine,
  transcribeWithDyadEngine,
} from "./llm_engine_provider";

function providerOptions(fetch = vi.fn()) {
  return {
    apiKey: "not-a-real-key",
    baseURL: "https://provider.invalid/v1",
    dyadOptions: {},
    settings: {} as UserSettings,
    fetch,
  };
}

describe("createDyadEngine", () => {
  test.each(["chatModel", "freeChatModel", "responses", "anthropic"] as const)(
    "fails closed for the inherited %s provider entry point",
    (entryPoint) => {
      const fetch = vi.fn();
      const provider = createDyadEngine(providerOptions(fetch));

      expect(() =>
        provider[entryPoint]("legacy-model", { providerId: "legacy" }),
      ).toThrowError(
        expect.objectContaining({
          kind: DyadErrorKind.Precondition,
          message:
            "The inherited desktop provider engine is disabled; use the zapp model gateway.",
        }),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("transcribeWithDyadEngine", () => {
  test("fails closed without sending audio to an inherited provider", async () => {
    const fetch = vi.fn();

    await expect(
      transcribeWithDyadEngine(
        Buffer.from("audio"),
        "recording.webm",
        "request-1",
        providerOptions(fetch),
      ),
    ).rejects.toMatchObject({
      kind: DyadErrorKind.Precondition,
      message:
        "The inherited desktop provider engine is disabled; use the zapp model gateway.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
