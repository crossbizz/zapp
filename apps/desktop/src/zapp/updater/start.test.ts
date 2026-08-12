import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("update-electron-app", () => ({
  updateElectronApp: vi.fn(),
  UpdateSourceType: { StaticStorage: "StaticStorage" },
}));

import { updateElectronApp } from "update-electron-app";

import { startZappUpdater } from "./start";

const logger = {
  error: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startZappUpdater", () => {
  it.each(["stable", "beta"] as const)(
    "uses the signed R2 static feed for the %s channel",
    (channel) => {
      expect(
        startZappUpdater({
          channel,
          feedOrigin: "https://updates.zapp.build/",
          logger,
        }),
      ).toBe(true);

      expect(updateElectronApp).toHaveBeenCalledWith({
        logger,
        notifyUser: true,
        updateInterval: "60 minutes",
        updateSource: {
          type: "StaticStorage",
          baseUrl: `https://updates.zapp.build/desktop-updates/${channel}`,
        },
      });
    },
  );

  it.each([
    "http://updates.zapp.build",
    ["https://user:", "secret@updates.zapp.build"].join(""),
    "https://updates.zapp.build/path?token=secret",
    "https://updates.zapp.build/path#fragment",
  ])("refuses an unsafe feed origin without starting", (feedOrigin) => {
    expect(startZappUpdater({ channel: "stable", feedOrigin, logger })).toBe(
      false,
    );
    expect(updateElectronApp).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Auto-update disabled: invalid ZAPP_UPDATE_FEED.",
    );
  });

  it("keeps updater initialization failure from blocking launch", () => {
    vi.mocked(updateElectronApp).mockImplementationOnce(() => {
      throw new Error("Squirrel unavailable");
    });

    expect(
      startZappUpdater({
        channel: "stable",
        feedOrigin: "https://updates.zapp.build",
        logger,
      }),
    ).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      "Auto-update initialization failed.",
      expect.any(Error),
    );
  });
});
