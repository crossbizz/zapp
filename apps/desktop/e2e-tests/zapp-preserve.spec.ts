/**
 * zapp: PRD §21.1 capability-preservation regression suite (MAC-3).
 *
 * These specs are a *regression net*, not a wish list. Every assertion here
 * passes on the build as it exists today, so that MAC-4+ (swapping Dyad's local
 * agent internals for zapp `WorkspaceRuntime` contracts) has a hard signal the
 * moment a preserved capability regresses.
 *
 * One test per §21.1 capability that Dyad actually ships today:
 *   1. local file access          — app files materialize under the apps dir,
 *                                   and an in-app editor save reaches disk
 *   2. terminal / PTY             — the in-chat terminal is a real pty rooted
 *                                   at the app directory
 *   3. bundled git operations     — repo init + initial commit, executed by the
 *                                   git binary shipped inside the app bundle
 *   4. local process management   — dev server start / stop / restart
 *   5. local preview renders      — the running template renders in the preview
 *   6. window / protocol handling — `zapp://` deep links reach the handler,
 *                                   restore the window, and reject `dyad://`
 *
 * Docker-mode preservation lives in `zapp-preserve-docker.spec.ts`, which is
 * env-gated so runners without Docker report a visible skip.
 *
 * ---------------------------------------------------------------------------
 * Location: this file lives in `e2e-tests/` (not `test/`, as the MAC-3 plan
 * sketched) because `playwright.config.ts` pins `testDir: "./e2e-tests"`. A spec
 * under `test/` would never be collected by `npm run e2e`, so it would look
 * green while running nothing. Reusing upstream's directory also means these
 * specs inherit the existing fixtures, page objects, fake-LLM webServer and
 * teardown instead of forking a second harness (upstream-merge cost, PRD §41).
 *
 * Runtime: upstream's `electronApp` fixture is test-scoped and `auto: true`, so
 * every test launches (and tears down) its own Electron instance with its own
 * `--user-data-dir`. That is the upstream contract; sharing one instance would
 * mean forking the fixture. Cost is ~20-30s per test, ~3 min for the file.
 */

import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { testSkipIfWindows, Timeout } from "./helpers/test_helper";
import {
  getActiveEditorModelContent,
  selectFileAndWaitForEditor,
} from "./helpers/monaco_editor";

/**
 * Run a git command against an app repo, tolerating `index.lock` contention.
 *
 * The app stages/commits on its own schedule (file saves, version checkpoints),
 * so a test-side git invocation can collide with an in-flight app-side one.
 * Per MAC-3: wait 3s and retry, at most 5 times.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const maxAttempts = 5;
  const waitMs = 3_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    } catch (error: any) {
      const output = `${error?.stderr ?? ""}${error?.stdout ?? ""}`;
      if (!output.includes("index.lock")) {
        throw error;
      }
      lastError = error;
      if (attempt === maxAttempts) break;
      console.log(
        `[preserve] git ${args.join(" ")} hit index.lock ` +
          `(attempt ${attempt}/${maxAttempts}); retrying in ${waitMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

/** Returns the HTTP status for `url`, or null when the port refuses/times out. */
async function probe(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Types `content` into the focused Monaco editor, replacing what is there.
 *
 * Not using `helpers/monaco_editor.ts#replaceEditorContent`: it focuses
 * `.monaco-editor textarea`, which on this Monaco version resolves to the
 * aria-hidden `textarea.ime-text-area` rather than the real input surface
 * (`div.native-edit-context`), so keystrokes are dropped. Clicking the rendered
 * lines is both what a user does and what actually gives the editor focus.
 * Fixing the shared helper is upstream-test surface, out of scope for MAC-3.
 */
async function typeIntoEditor(
  page: import("@playwright/test").Page,
  content: string,
) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(content);
  await expect
    .poll(
      async () =>
        (await getActiveEditorModelContent(page))?.replace(/\r\n?/g, "\n"),
      { timeout: Timeout.MEDIUM },
    )
    .toBe(content.replace(/\r\n?/g, "\n"));
}

/** Reads the xterm buffer the terminal panel exposes for e2e. */
async function terminalText(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const terminal = (window as any).__DYAD_TERMINAL__;
    if (!terminal) return "";
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  });
}

/**
 * Types `command` into the in-app terminal and waits for `expected` output.
 *
 * Retries the whole line because a freshly spawned pty can swallow the first
 * keystrokes (observed: "tty" arriving as "y"). Ctrl+U is readline/zle's
 * kill-line, so a retry starts from an empty prompt instead of appending to
 * whatever partial text survived.
 */
async function runInTerminal(
  page: import("@playwright/test").Page,
  command: string,
  expected: RegExp,
) {
  await expect(async () => {
    await page.keyboard.press("Control+u");
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(page), { timeout: Timeout.SHORT })
      .toMatch(expected);
  }).toPass({ timeout: Timeout.LONG });
}

// ---------------------------------------------------------------------------
// 1. Local file access
// ---------------------------------------------------------------------------

testSkipIfWindows(
  "preserve: local file access — app files land under the apps dir and editor saves reach disk",
  async ({ po }) => {
    // Auto-approve + waiting for the post-import AI_RULES turn to finish keeps
    // the code pane out of proposal-review mode, where the editor is not the
    // editable file view.
    await po.setUp({ autoApprove: true });
    await po.importApp("minimal");
    await po.chatActions.waitForChatCompletion({ timeout: Timeout.LONG });

    const appPath = await po.appManagement.getCurrentAppPath();
    const appsDir = path.join(po.userDataDir, "dyad-apps");

    // The app owns a real directory on the local filesystem, inside the
    // managed apps root (not a temp scratch dir, not a remote handle).
    expect(fs.statSync(appPath).isDirectory()).toBe(true);
    expect(path.resolve(appPath).startsWith(path.resolve(appsDir))).toBe(true);

    // Read path: the imported tree is on disk verbatim.
    for (const relativePath of [
      "package.json",
      "index.html",
      "vite.config.ts",
      path.join("src", "App.tsx"),
      path.join("src", "main.tsx"),
    ]) {
      expect(
        fs.existsSync(path.join(appPath, relativePath)),
        `expected ${relativePath} on disk`,
      ).toBe(true);
    }
    expect(
      fs.readFileSync(path.join(appPath, "src", "App.tsx"), "utf8"),
    ).toContain("Minimal imported app");

    // Write path: an edit made in the in-app editor must hit the same bytes on
    // disk. This is the half that a runtime swap is most likely to break.
    await po.previewPanel.clickTogglePreviewPanel();
    await po.previewPanel.selectPreviewMode("code");
    await expect(
      po.page.getByText("Loading files...", { exact: false }),
    ).toBeHidden({ timeout: Timeout.LONG });

    await selectFileAndWaitForEditor(po.page, "App.tsx");
    const editedSource =
      "const App = () => <div>preserve-suite local write</div>;\n\nexport default App;\n";
    await typeIntoEditor(po.page, editedSource);
    await po.page.getByTestId("save-file-button").click();

    await expect
      .poll(
        () =>
          fs
            .readFileSync(path.join(appPath, "src", "App.tsx"), "utf8")
            .replace(/\r\n?/g, "\n"),
        { timeout: Timeout.MEDIUM },
      )
      .toContain("preserve-suite local write");
  },
);

// ---------------------------------------------------------------------------
// 2. Terminal / PTY
// ---------------------------------------------------------------------------

testSkipIfWindows(
  "preserve: terminal/PTY — the in-chat terminal is a real pty rooted at the app",
  async ({ po }) => {
    // The terminal panel is gated behind dev mode or this e2e flag
    // (TerminalPanel.tsx). Set it before setUp so the toggle renders.
    await po.page.evaluate(() => {
      (window as any).__DYAD_E2E__ = true;
    });
    await po.setUp();
    await po.importApp("minimal");

    const appPath = await po.appManagement.getCurrentAppPath();
    const appFolder = path.basename(appPath);

    const toggle = po.page.getByTestId("toggle-terminal-button");
    await expect(toggle).toBeVisible({ timeout: Timeout.MEDIUM });
    await toggle.click();

    await expect(po.page.getByTestId("terminal-drawer")).toBeVisible({
      timeout: Timeout.MEDIUM,
    });
    await expect(po.page.getByTestId("terminal-xterm")).toBeVisible();

    // Wait for the shell to paint a prompt before typing: keystrokes sent
    // while the pty is still spawning are dropped on the floor.
    await expect
      .poll(() => terminalText(po.page).then((text) => text.trim().length), {
        timeout: Timeout.LONG,
      })
      .toBeGreaterThan(0);

    // `tty` prints a device path only when stdin is an actual terminal device,
    // and "not a tty" otherwise. This distinguishes node-pty from a plain piped
    // child process — the exact thing a runtime swap could silently downgrade.
    // (The typed command itself contains no "/dev/", so this matches output.)
    await runInTerminal(po.page, "tty", /\/dev\/(tty|pts)/);

    // Rooted at the app directory, not at the Electron cwd. Asserting on the
    // *expansion* rather than the literal command keeps the echoed input (and
    // any cwd the shell prompt happens to render) from satisfying this.
    await runInTerminal(
      po.page,
      'echo "PRESERVE-CWD-$(basename "$PWD")"',
      new RegExp(`PRESERVE-CWD-${appFolder}`),
    );

    // Commands actually execute: the arithmetic expansion only resolves if a
    // real shell ran the line, so this cannot pass off the input echo.
    await runInTerminal(
      po.page,
      'echo "PRESERVE-EXEC-$((6*7))"',
      /PRESERVE-EXEC-42/,
    );
  },
);

// ---------------------------------------------------------------------------
// 3. Bundled git operations
// ---------------------------------------------------------------------------

testSkipIfWindows(
  "preserve: bundled git — project init produces a repo with a commit from the bundled binary",
  async ({ po }) => {
    await po.setUp();

    // The app points dugite at a git it ships itself (main.ts
    // resolveLocalGitDirectory -> LOCAL_GIT_DIRECTORY), so git operations do
    // not depend on a system git being installed. Assert the binary is real
    // and inside the app bundle before asserting on its output.
    const localGitDirectory = await po.electronApp.evaluate(
      () => process.env.LOCAL_GIT_DIRECTORY,
    );
    const resourcesPath = await po.electronApp.evaluate(
      () => process.resourcesPath,
    );
    expect(localGitDirectory).toBeTruthy();
    expect(path.resolve(localGitDirectory!)).toBe(
      path.resolve(path.join(resourcesPath, "git")),
    );

    const bundledGit = path.join(localGitDirectory!, "bin", "git");
    expect(
      fs.existsSync(bundledGit),
      `expected bundled git at ${bundledGit}`,
    ).toBe(true);
    expect(
      execFileSync(bundledGit, ["--version"], { encoding: "utf8" }),
    ).toContain("git version");

    await po.importApp("minimal");
    const appPath = await po.appManagement.getCurrentAppPath();

    // Repo init happened as part of project creation (import_handlers ->
    // gitService.initRepoWithInitialCommit).
    await expect
      .poll(() => fs.existsSync(path.join(appPath, ".git")), {
        timeout: Timeout.MEDIUM,
      })
      .toBe(true);

    await expect
      .poll(() => git(appPath, "rev-list", "--count", "HEAD"), {
        timeout: Timeout.MEDIUM,
      })
      .toBe("1");

    // `gitInit` forces `-b main`; the initial commit is authored by the app's
    // own identity (git_author.ts), not by whatever ambient user.name the
    // machine has. Both together prove the commit came from the app's git
    // layer rather than from developer tooling or the test itself.
    expect(await git(appPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "main",
    );
    expect(await git(appPath, "log", "-1", "--format=%an")).toBe("[dyad]");
    expect(await git(appPath, "log", "-1", "--format=%ae")).toBe("git@dyad.sh");
    expect(await git(appPath, "log", "-1", "--format=%s")).toContain(
      "Init Dyad app",
    );

    // The imported tree is tracked, not just sitting untracked next to a repo.
    const tracked = (await git(appPath, "ls-files")).split("\n");
    expect(tracked).toContain("package.json");
    expect(tracked).toContain("src/App.tsx");
    expect(await git(appPath, "status", "--porcelain", "--", "src")).toBe("");
  },
);

// ---------------------------------------------------------------------------
// 4. Local process management
// ---------------------------------------------------------------------------

testSkipIfWindows(
  "preserve: local process management — dev server starts, stops, and restarts on demand",
  async ({ po }) => {
    await po.setUp();
    await po.importApp("minimal");

    await po.previewPanel.expectPreviewIframeIsVisible(Timeout.EXTRA_LONG);
    const iframeSrc = await po.previewPanel
      .getPreviewIframeElement()
      .getAttribute("src");
    expect(iframeSrc, "preview iframe should have a local src").toBeTruthy();
    const origin = new URL(iframeSrc!).origin;
    expect(origin).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+$/);

    // Running: a local process is actually listening and serving.
    await expect.poll(() => probe(origin), { timeout: Timeout.LONG }).toBe(200);

    const appId = await po.page.evaluate(async () => {
      const result = await (window as any).electron.ipcRenderer.invoke(
        "list-apps",
        undefined,
      );
      return result.apps[0].id as number;
    });

    // Stopped: `stop-app` kills the dev server process and terminates the
    // preview proxy worker, so the port stops answering entirely.
    await po.page.evaluate(
      async (id) =>
        (window as any).electron.ipcRenderer.invoke("stop-app", { appId: id }),
      appId,
    );
    await expect
      .poll(() => probe(origin), { timeout: Timeout.LONG })
      .toBeNull();

    // Restarted: `run-app` brings a fresh process back up and serving.
    await po.page.evaluate(
      async (id) =>
        (window as any).electron.ipcRenderer.invoke("run-app", { appId: id }),
      appId,
    );
    await expect
      .poll(
        async () => {
          const src = await po.previewPanel
            .getPreviewIframeElement()
            .getAttribute("src")
            .catch(() => null);
          if (!src) return null;
          return probe(new URL(src).origin);
        },
        { timeout: Timeout.EXTRA_LONG },
      )
      .toBe(200);
  },
);

// ---------------------------------------------------------------------------
// 5. Local preview renders
// ---------------------------------------------------------------------------

testSkipIfWindows(
  "preserve: local preview renders — the running template paints in the preview pane",
  async ({ po }) => {
    await po.setUp();
    await po.importApp("minimal");

    // Importing lands on the preview tab already; re-selecting the mode here
    // would race the panel's own expand animation.
    await po.previewPanel.expectPreviewIframeIsVisible(Timeout.EXTRA_LONG);

    // The loading screen must actually clear — a preview stuck on "starting"
    // is the failure mode a runtime swap produces.
    await expect(po.previewPanel.locatePreviewLoadingScreen()).toBeHidden({
      timeout: Timeout.EXTRA_LONG,
    });
    await expect(po.previewPanel.locatePreviewErrorBanner()).toBeHidden();

    // The iframe renders the imported template's own markup, which only exists
    // if the local dev server compiled and served that source.
    const body = po.previewPanel
      .getPreviewIframeElement()
      .contentFrame()
      .locator("body");
    await expect(body).toContainText("Minimal imported app", {
      timeout: Timeout.EXTRA_LONG,
    });
  },
);

// ---------------------------------------------------------------------------
// 6. Window / protocol handling
// ---------------------------------------------------------------------------

testSkipIfWindows(
  "preserve: window/protocol handling — zapp:// deep links reach the handler and restore the window",
  async ({ po, electronApp }) => {
    await po.setUp();

    // Note on `second-instance`: E2E builds skip `requestSingleInstanceLock()`
    // (main.ts, so workers can run in parallel), and the `second-instance`
    // listener is only registered inside that lock. The URL delivery seam it
    // feeds is identical to the one exercised here — both call
    // `deepLinkQueue.handle(url)` (main.ts) — and the queue itself has unit
    // coverage in `src/main/deep_link_queue.test.ts`. So this spec drives the
    // `open-url` entry point, which is the one a packaged macOS build receives.

    // Record error dialogs instead of showing them: `showErrorBox` is modal, so
    // an unhandled scheme would otherwise hang the run.
    await electronApp.evaluate(({ dialog }) => {
      (globalThis as any).__zappErrorBoxes = [];
      dialog.showErrorBox = (title: string, content: string) => {
        (globalThis as any).__zappErrorBoxes.push({ title, content });
      };
    });
    const errorBoxes = () =>
      electronApp.evaluate(
        () => (globalThis as any).__zappErrorBoxes as { title: string }[],
      );

    // Exactly one app window, and it is a real visible window.
    const windowState = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return { count: windows.length, visible: windows[0]?.isVisible() };
    });
    expect(windowState).toEqual({ count: 1, visible: true });

    // The legacy scheme must be rejected: this fork claims `zapp://` only, and
    // silently accepting `dyad://` would mean intercepting a Dyad install.
    await electronApp.evaluate(({ app }) => {
      app.emit("open-url", { preventDefault: () => {} }, "dyad://project/p_1");
    });
    await expect
      .poll(async () => (await errorBoxes()).map((box) => box.title), {
        timeout: Timeout.MEDIUM,
      })
      .toEqual(["Invalid Protocol"]);

    // A zapp-owned route is consumed and un-minimizes + focuses the window
    // (zapp/deep_link.ts focusWindow), which is the whole point of a browser
    // hand-off landing on the desktop app.
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].minimize();
    });
    await expect
      .poll(
        () =>
          electronApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].isMinimized(),
          ),
        { timeout: Timeout.MEDIUM },
      )
      .toBe(true);

    await electronApp.evaluate(({ app }) => {
      app.emit(
        "open-url",
        { preventDefault: () => {} },
        "zapp://project/p_preserve",
      );
    });
    await expect
      .poll(
        () =>
          electronApp.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].isMinimized(),
          ),
        { timeout: Timeout.MEDIUM },
      )
      .toBe(false);
    // Consumed by the zapp route, so no second error dialog.
    expect(await errorBoxes()).toHaveLength(1);

    // Full chain on the new scheme: OS event -> deep link queue -> main
    // handler -> renderer. An inherited Dyad route is used deliberately, to
    // prove the rebrand moved the scheme without dropping existing routes.
    await po.navigation.goToLibraryTab();
    const promptData = {
      title: "Preserve Suite Deep Link",
      description: "created by the MAC-3 preserve suite",
      content: "zapp preserve deep link content",
    };
    const base64Data = Buffer.from(JSON.stringify(promptData)).toString(
      "base64",
    );
    await electronApp.evaluate(
      ({ app }, url) => {
        app.emit("open-url", { preventDefault: () => {} }, url);
      },
      `zapp://add-prompt?data=${encodeURIComponent(base64Data)}`,
    );

    await expect(
      po.page.getByRole("dialog").getByText("Create New Prompt"),
    ).toBeVisible({ timeout: Timeout.MEDIUM });
    await expect(po.page.getByRole("textbox", { name: "Title" })).toHaveValue(
      promptData.title,
    );
  },
);
