import { beforeEach, describe, expect, it, vi } from "vitest";

// The real module requires electron at import time, so it is replaced wholesale
// rather than spied on.
vi.mock("update-electron-app", () => ({
  updateElectronApp: vi.fn(),
  UpdateSourceType: {
    ElectronPublicUpdateService: "ElectronPublicUpdateService",
  },
}));

import { updateElectronApp } from "update-electron-app";
import type { UserSettings } from "@/lib/schemas";
import { startAutoUpdate, ZAPP_DEFAULT_UPDATE_REPO } from "./auto_update";

const logger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function settingsWith(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    enableAutoUpdate: true,
    releaseChannel: "stable",
    ...overrides,
  } as UserSettings;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("startAutoUpdate", () => {
  it("does not start an updater when ZAPP_UPDATE_FEED is unset", () => {
    vi.stubEnv("ZAPP_UPDATE_FEED", "");

    expect(startAutoUpdate({ settings: settingsWith(), logger })).toBe(false);
    expect(updateElectronApp).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Auto-update skipped: ZAPP_UPDATE_FEED is not set.",
    );
  });

  it("treats a whitespace-only feed as unset", () => {
    vi.stubEnv("ZAPP_UPDATE_FEED", "   ");

    expect(startAutoUpdate({ settings: settingsWith(), logger })).toBe(false);
    expect(updateElectronApp).not.toHaveBeenCalled();
  });

  it("starts against the zapp feed and repo when ZAPP_UPDATE_FEED is set", () => {
    vi.stubEnv("ZAPP_UPDATE_FEED", "https://updates.zapp.build/v1/update");

    expect(startAutoUpdate({ settings: settingsWith(), logger })).toBe(true);
    expect(updateElectronApp).toHaveBeenCalledTimes(1);
    expect(updateElectronApp).toHaveBeenCalledWith(
      expect.objectContaining({
        updateInterval: "60 minutes",
        updateSource: {
          type: "ElectronPublicUpdateService",
          repo: ZAPP_DEFAULT_UPDATE_REPO,
          host: "https://updates.zapp.build/v1/update/stable",
        },
      }),
    );
    expect(ZAPP_DEFAULT_UPDATE_REPO).toBe("crossbizz/zapp");
  });

  it("keeps upstream's release-channel postfix and tolerates a trailing slash", () => {
    vi.stubEnv("ZAPP_UPDATE_FEED", "https://updates.zapp.build/v1/update/");

    startAutoUpdate({
      settings: settingsWith({ releaseChannel: "beta" }),
      logger,
    });

    expect(updateElectronApp).toHaveBeenCalledWith(
      expect.objectContaining({
        updateSource: expect.objectContaining({
          host: "https://updates.zapp.build/v1/update/beta",
        }),
      }),
    );
  });

  it("falls back to stable for an unknown release channel", () => {
    vi.stubEnv("ZAPP_UPDATE_FEED", "https://updates.zapp.build/v1/update");

    startAutoUpdate({
      settings: settingsWith({
        releaseChannel: "nightly" as UserSettings["releaseChannel"],
      }),
      logger,
    });

    expect(updateElectronApp).toHaveBeenCalledWith(
      expect.objectContaining({
        updateSource: expect.objectContaining({
          host: "https://updates.zapp.build/v1/update/stable",
        }),
      }),
    );
  });

  it("allows the repo to be overridden", () => {
    vi.stubEnv("ZAPP_UPDATE_FEED", "https://updates.zapp.build/v1/update");
    vi.stubEnv("ZAPP_UPDATE_REPO", "crossbizz/zapp-canary");

    startAutoUpdate({ settings: settingsWith(), logger });

    expect(updateElectronApp).toHaveBeenCalledWith(
      expect.objectContaining({
        updateSource: expect.objectContaining({
          repo: "crossbizz/zapp-canary",
        }),
      }),
    );
  });

  it("never points at Dyad's feed or repository", () => {
    vi.stubEnv("ZAPP_UPDATE_FEED", "https://updates.zapp.build/v1/update");

    startAutoUpdate({ settings: settingsWith(), logger });

    const serialized = JSON.stringify(
      vi.mocked(updateElectronApp).mock.calls[0],
    );
    expect(serialized).not.toContain("dyad");
  });
});
