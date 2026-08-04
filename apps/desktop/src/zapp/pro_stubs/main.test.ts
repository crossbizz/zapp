import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { apps } from "@/db/schema";
import { DyadErrorKind } from "@/errors/dyad_error";
import { themesData } from "@/shared/themes";
import {
  type HandlerTestHarness,
  setupHandlerTestHarness,
} from "@/testing/handler_test_harness";

import { registerThemesHandlers } from "./main";

/**
 * Built-in theme selection is NOT Pro-only: `apps.theme_id`, `themesData` and
 * `getThemePromptById` all survive in the Apache-2.0 tree, and
 * `chat_stream_handlers` reads the column on every turn. Rejecting
 * `set-app-theme` therefore broke app creation outright — `applyTheme` runs for
 * every first prompt because `selectedThemeId` defaults to "default" — so these
 * handlers persist against the retained column instead. AI theme *generation*
 * and custom-theme CRUD really were Pro and stay unavailable.
 */
describe("registerThemesHandlers", () => {
  let harness: HandlerTestHarness;

  beforeEach(() => {
    harness = setupHandlerTestHarness();
    registerThemesHandlers();
  });

  afterEach(() => {
    harness.dispose();
  });

  function seedApp(name = "app-1"): number {
    const result = harness.db.insert(apps).values({ name, path: name }).run();
    return Number(result.lastInsertRowid);
  }

  function readThemeId(appId: number) {
    return harness.db.select().from(apps).where(eq(apps.id, appId)).get()
      ?.themeId;
  }

  it("persists a theme selection to apps.themeId", async () => {
    const appId = seedApp();

    await harness.invokeHandler("set-app-theme", { appId, themeId: "default" });

    expect(readThemeId(appId)).toBe("default");
  });

  it("reads the persisted theme back", async () => {
    const appId = seedApp();
    await harness.invokeHandler("set-app-theme", { appId, themeId: "default" });

    await expect(
      harness.invokeHandler("get-app-theme", { appId }),
    ).resolves.toBe("default");
  });

  it("reports no theme for an app that has never had one set", async () => {
    const appId = seedApp();

    await expect(
      harness.invokeHandler("get-app-theme", { appId }),
    ).resolves.toBeNull();
  });

  it("clears the selection when themeId is null", async () => {
    const appId = seedApp();
    await harness.invokeHandler("set-app-theme", { appId, themeId: "default" });

    await harness.invokeHandler("set-app-theme", { appId, themeId: null });

    expect(readThemeId(appId)).toBeNull();
    await expect(
      harness.invokeHandler("get-app-theme", { appId }),
    ).resolves.toBeNull();
  });

  it("keeps custom theme ids addressable so getThemePromptById can resolve them", async () => {
    const appId = seedApp();

    await harness.invokeHandler("set-app-theme", {
      appId,
      themeId: "custom:7",
    });

    expect(readThemeId(appId)).toBe("custom:7");
  });

  it("rejects setting a theme on an app that does not exist", async () => {
    await expect(
      harness.invokeHandler("set-app-theme", {
        appId: 9999,
        themeId: "default",
      }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.NotFound });
  });

  it("rejects reading a theme for an app that does not exist", async () => {
    await expect(
      harness.invokeHandler("get-app-theme", { appId: 9999 }),
    ).rejects.toMatchObject({ kind: DyadErrorKind.NotFound });
  });

  it("serves the built-in themes so the picker is not empty after load", async () => {
    await expect(harness.invokeHandler("get-themes")).resolves.toEqual(
      themesData,
    );
  });

  it("still reports AI theme generation as unavailable", async () => {
    await expect(
      harness.invokeHandler("generate-theme-prompt", {}),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Precondition });
  });

  it("still reports custom theme creation as unavailable", async () => {
    await expect(
      harness.invokeHandler("create-custom-theme", {}),
    ).rejects.toMatchObject({ kind: DyadErrorKind.Precondition });
  });
});
