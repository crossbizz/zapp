/**
 * zapp: PRD §21.1 capability preservation — Docker runtime mode (MAC-3).
 *
 * Split out from `zapp-preserve.spec.ts` because it is env-gated: Docker mode
 * builds an image and runs a container, which most runners (and all current
 * desktop CI runners) cannot do. The gate is deliberately two-part —
 * `DOCKER_AVAILABLE=1` is an explicit opt-in, and `docker info` must actually
 * succeed — so an unset env var and a dead daemon both produce a *visible*
 * skip with a reason rather than a silent pass or a red run.
 *
 *   DOCKER_AVAILABLE=1 npm run test:preserve
 */

import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { test, testSkipIfWindows, Timeout } from "./helpers/test_helper";
import { DYAD_LEGACY } from "./zapp-preserve-constants";

function resolveDockerGate(): { available: boolean; reason: string } {
  if (process.env.DOCKER_AVAILABLE !== "1") {
    return {
      available: false,
      reason:
        "Docker preserve specs are opt-in: set DOCKER_AVAILABLE=1 on a runner with Docker.",
    };
  }
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 60_000 });
    return { available: true, reason: "" };
  } catch (error) {
    return {
      available: false,
      reason: `DOCKER_AVAILABLE=1 but \`docker info\` failed (is the daemon running?): ${error}`,
    };
  }
}

const dockerGate = resolveDockerGate();

// File scope, not inside the test body: the `electronApp` / `po` fixtures are
// `auto: true`, so a body-level skip would still launch and tear down a whole
// Electron instance first — and an unrelated launch failure would then turn an
// intended skip red. Skipping here means the test is never entered at all.
//
// The reason rides along as a Playwright annotation (visible in the HTML / blob
// report); log it too so a plain line-reporter CI log says *why* the Docker
// capability went unverified instead of just "1 skipped".
if (!dockerGate.available) {
  console.log(`[preserve:docker] SKIPPED — ${dockerGate.reason}`);
}
test.skip(!dockerGate.available, dockerGate.reason);

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function removeContainer(name: string) {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // Best effort: the container may already be gone.
  }
}

testSkipIfWindows(
  "preserve: docker runtime — the app builds and runs inside a container",
  async ({ po }) => {
    // Image build + in-container install is far slower than a host run.
    test.setTimeout(15 * 60_000);

    let containerName: string | undefined;
    try {
      await po.setUp();

      await po.navigation.goToSettingsTab();
      await po.settings.changeRuntimeMode("docker");
      await expect
        .poll(() => po.settings.recordSettings().runtimeMode2, {
          timeout: Timeout.MEDIUM,
        })
        .toBe("docker");

      await po.navigation.goToAppsTab();
      await po.importApp("minimal");

      const appPath = await po.appManagement.getCurrentAppPath();
      const appId = await po.page.evaluate(async () => {
        const result = await (window as any).electron.ipcRenderer.invoke(
          "list-apps",
          undefined,
        );
        return result.apps[0].id as number;
      });
      containerName = DYAD_LEGACY.dockerContainerName(appId);

      // The Docker runtime path materializes its own build recipe next to the
      // app source (app_runtime_service executeAppInDocker).
      await expect
        .poll(() => fs.existsSync(path.join(appPath, "Dockerfile.dyad")), {
          timeout: Timeout.EXTRA_LONG,
        })
        .toBe(true);

      // A real container is running for this app, not a host process.
      await expect
        .poll(
          () =>
            docker(
              "ps",
              "--filter",
              `name=^/${containerName}$`,
              "--format",
              "{{.Names}}",
            ),
          { timeout: 10 * 60_000, intervals: [2_000] },
        )
        .toBe(containerName);

      // And the containerized dev server serves the imported template.
      // (No `selectPreviewMode("preview")`: importing already lands there, and
      // re-selecting races the panel's expand animation into a collapse.)
      await po.previewPanel.expectPreviewIframeIsVisible(Timeout.EXTRA_LONG);
      await expect(
        po.previewPanel
          .getPreviewIframeElement()
          .contentFrame()
          .locator("body"),
      ).toContainText("Minimal imported app", { timeout: 5 * 60_000 });
    } finally {
      // `docker run --rm` is started as a foreground child; killing Electron
      // orphans the container, so reap it explicitly.
      if (containerName) {
        removeContainer(containerName);
      }
    }
  },
);
