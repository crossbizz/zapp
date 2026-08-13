import { describe, expect, it } from "vitest";

import { screen } from "@testing-library/react";

import { setupHybridChatHarness } from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";

type TestWindow = Window &
  typeof globalThis & {
    electron: {
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      };
    };
  };

describe("hybrid chat harness guards", () => {
  it("registers the production platform-auth boundary with a deterministic signed-out session", async () => {
    const harness = await setupHybridChatHarness({
      electronMock: h,
      settings: { isTestMode: true },
    });

    try {
      await expect(
        (window as TestWindow).electron.ipcRenderer.invoke(
          "zapp-auth:snapshot",
          {},
        ),
      ).resolves.toEqual({ status: "signed-out" });

      harness.mountSurface({ route: "/app-details", withTitleBar: true });
      expect(await screen.findByTestId("app-details-page")).toBeTruthy();
      expect(
        await screen.findByRole("button", { name: "Sign in to Zapp" }),
      ).toBeTruthy();

      const { getRemoteDesktopConfig } =
        await import("@/ipc/shared/remote_desktop_config");
      await expect(getRemoteDesktopConfig()).resolves.toMatchObject({
        version: "e2e-test-desktop-config-v1",
        defaults: {},
      });
    } finally {
      await harness.dispose();
    }
  }, 60_000);

  it("installs the local-agent composition used by the desktop main process", async () => {
    const harness = await setupHybridChatHarness({
      electronMock: h,
      chatMode: "local-agent",
      settings: { isTestMode: true },
    });

    try {
      const result = await harness.streamChat("tc=local-agent/simple-response");

      expect(result.event("chat:response:error")).toBeUndefined();
      expect(result.eventsFor("chat:response:chunk")).not.toHaveLength(0);
      expect(result.eventsFor("chat:response:end")).toHaveLength(1);
      const request = harness.capturedCompletions().at(-1);
      expect(request?.messages.at(-1)).toMatchObject({
        role: "user",
        content: "tc=local-agent/simple-response",
      });
      expect(request?.tools?.map((tool) => tool.name)).toEqual([
        "read_file",
        "list_files",
        "write_file",
        "apply_patch",
        "copy_file",
        "rename_file",
        "delete_file",
      ]);
    } finally {
      await harness.dispose();
    }
  }, 60_000);

  it("mounts non-chat surfaces without pulling preview UI into the DOM", async () => {
    const surfaceCases = [
      {
        route: "/app-details" as const,
        testId: "app-details-page",
        withTitleBar: true,
      },
      { route: "/database" as const, testId: "database-section" },
      { route: "/settings" as const, text: "Settings" },
      {
        route: "/settings/providers/$provider" as const,
        text: "Configure Dyad",
      },
      { route: "/library/media" as const, text: "Media" },
      { route: "/import-app" as const, text: "Import App" },
    ];

    for (const surface of surfaceCases) {
      const harness = await setupHybridChatHarness({
        electronMock: h,
        settings: { isTestMode: true },
      });
      try {
        harness.mountSurface({
          route: surface.route,
          withTitleBar: surface.withTitleBar,
        });

        if (surface.testId) {
          expect(await screen.findByTestId(surface.testId)).toBeTruthy();
        } else if (surface.text) {
          expect(await screen.findByText(surface.text)).toBeTruthy();
        }
        expect(screen.queryByTestId("preview-iframe-element")).toBeNull();
        // FileEditor has no root testid; its header save button renders
        // unconditionally, so it proxies "FileEditor mounted".
        expect(screen.queryByTestId("save-file-button")).toBeNull();
      } finally {
        await harness.dispose();
      }
    }
  }, 120_000);

  it("fails dispose on missing renderer channels and clears the setup guard", async () => {
    const harness = await setupHybridChatHarness({
      electronMock: h,
      settings: { isTestMode: true },
    });

    // A channel OUTSIDE the preload whitelist throws synchronously, exactly
    // like preload.ts does in the packaged app.
    expect(() =>
      (window as TestWindow).electron.ipcRenderer.invoke(
        "missing:test-channel",
      ),
    ).toThrow("Invalid channel: missing:test-channel");

    // Remove one whitelisted handler to exercise the bridge's missing-channel
    // path in both normal Vitest and the package-level E2E_TEST_BUILD run.
    // The node harness clears the whole handler map during dispose.
    h.ipcHandlers.delete("test:set-node-mock");
    await expect(
      (window as TestWindow).electron.ipcRenderer.invoke("test:set-node-mock"),
    ).rejects.toThrow("test:set-node-mock");

    await expect(harness.dispose()).rejects.toThrow("test:set-node-mock");

    const nextHarness = await setupHybridChatHarness({
      electronMock: h,
      settings: { isTestMode: true },
    });
    await nextHarness.dispose();
  }, 60_000);

  it("provides a deterministic clock for first-prompt timer transitions", async () => {
    const harness = await setupHybridChatHarness({
      electronMock: h,
      settings: { isTestMode: true },
    });

    try {
      expect(() => harness.advanceFirstPromptClock(1)).toThrow(
        "mountSurface() must be called",
      );

      harness.mountSurface({ route: "/settings" });
      expect(() => harness.advanceFirstPromptClock(60_000)).not.toThrow();
    } finally {
      await harness.dispose();
    }
  }, 60_000);
});
