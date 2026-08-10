import { afterEach, describe, expect, test, vi } from "vitest";

import { DyadErrorKind } from "@/errors/dyad_error";
import type { UserSettings } from "@/lib/schemas";

import {
  getModelClient,
  setModelClientFetchForTesting,
} from "./get_model_client";

describe("getModelClient", () => {
  afterEach(() => {
    setModelClientFetchForTesting(undefined);
  });

  test.each([
    { provider: "auto", name: "auto" },
    { provider: "anthropic", name: "claude-sonnet-4-20250514" },
    { provider: "openrouter", name: "openrouter/free" },
  ])("fails closed for inherited desktop provider $provider", async (model) => {
    const fetch = vi.fn();
    setModelClientFetchForTesting(fetch);

    await expect(
      getModelClient(model, {} as UserSettings),
    ).rejects.toMatchObject({
      kind: DyadErrorKind.Precondition,
      message:
        "Direct desktop model clients are disabled; use the authenticated zapp local-agent session.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
