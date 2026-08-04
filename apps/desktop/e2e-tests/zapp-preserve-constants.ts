/**
 * zapp: the Dyad-branded facts the preserve suite pins (MAC-3).
 *
 * The suite asserts on these strings on purpose — pinning the exact identity
 * the app writes is what makes it a regression net rather than a smoke test.
 * But they are also the surface a future de-Dyad rename will legitimately
 * change, so they live in one place: that rename should be a single edit here
 * plus whatever the app itself emits, not a hunt through two spec files.
 *
 * Not named `*.spec.ts` deliberately — Playwright's `testMatch` only collects
 * `*.spec.ts` / `*.test.ts`, so this stays a plain module rather than an empty
 * test file, and importing it cannot double-register tests.
 */
export const DYAD_LEGACY = {
  /** Folder under `userData` that holds every managed project. */
  appsDirName: "dyad-apps",

  /**
   * Identity `gitService.initRepoWithInitialCommit` commits under
   * (`src/ipc/utils/git_author.ts`). Asserting it proves the commit came from
   * the app's own git layer, not from ambient `user.name` config.
   */
  gitAuthorName: "[dyad]",
  gitAuthorEmail: "git@dyad.sh",

  /** Subject of the commit that project init creates. */
  initialCommitSubject: "Init Dyad app",

  /**
   * Renderer flag that un-hides the in-chat terminal outside dev builds
   * (`src/components/chat/TerminalPanel.tsx`).
   */
  e2eFlag: "__DYAD_E2E__",

  /** Window global the terminal panel exposes its xterm instance on. */
  terminalGlobal: "__DYAD_TERMINAL__",

  /** Container name Docker runtime mode gives an app's dev server. */
  dockerContainerName: (appId: number) => `dyad-app-${appId}`,
} as const;
