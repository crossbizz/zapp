# 0002 — Forking Dyad into `apps/desktop` without `src/pro`

Status: accepted (MAC-1, 2026-08-03)
Affects: `apps/desktop/**`, `NOTICE`, root `.prettierignore`
References: PRD §21, §38.1, §41; plan 09 (macOS application) task MAC-1

## Context

The zapp.build macOS app is built on Dyad's Electron Forge shell (plan 09). Dyad is
dual-licensed: everything outside `src/pro/` is Apache-2.0, while `src/pro/` is
proprietary (Functional Source License 1.1). Only the Apache-2.0 portion may be
vendored, and the licence boundary has to hold in git history, not just at HEAD.

MAC-2..12 keep taking upstream changes, so PRD §41 flags "fork drift" as the standing
risk: every line we change in the vendored tree is a line we resolve on every merge.

## Decision

### Pinned upstream

| | |
|---|---|
| Repository | https://github.com/dyad-sh/dyad |
| Release | `v1.9.0` (latest release, published 2026-07-27) |
| Commit | `282591ca8667a53b55ff0ce92c00d0d54162dab2` |
| Vendored at | `apps/desktop/` |

Attribution lives in the root `NOTICE`; Dyad's own `LICENSE` and `NOTICE` are preserved
verbatim inside `apps/desktop/`.

### The licence boundary is enforced before the copy, not after

`src/pro/` and `.git/` were deleted from the upstream checkout **before** any file was
copied into this repository, and the copy itself excludes `src/pro/`. No `src/pro` file
has ever been staged, committed, or present in this repository's history.

Verification (must stay clean):

```sh
# zero import specifiers referencing pro
grep -rnE "(from|import|require)\s*\(?\s*[\"'][^\"']*(^|[/\"'])pro/" apps/desktop/src
# zero files under a pro path
find apps/desktop -path '*/src/pro/*'
```

The only surviving matches for the string `pro/` in `apps/desktop/src` are the
`// zapp: pro-removed` markers described below.

### Pro import sites are repointed to purpose-written stubs

Rather than inlining a no-op at each call site, every former Pro symbol is re-exported
from two new modules under `apps/desktop/src/zapp/pro_stubs/`. Each is written from
scratch against the *call signature* used by the Apache-2.0 code that remains — no
upstream Pro implementation, logic, or prompt text is reproduced. Splitting main from
shared keeps Electron/IPC modules out of the renderer bundle.

- `pro_stubs/shared.ts` — process-agnostic: `parseSearchReplaceBlocks`,
  `SearchReplaceBlock`, `applySearchReplace`, `TURBO_EDITS_V2_SYSTEM_PROMPT`,
  `isSandboxScriptExecutionEnabled`, `AgentToolName`.
- `pro_stubs/main.ts` — main process: `registerThemesHandlers`,
  `registerVisualEditingHandlers`, `registerAgentToolHandlers`,
  `startChatSearchIndexer`, `stopChatSearchIndexer`, `scheduleChatSearchIndexing`,
  `cleanupOldAiMessagesJson`, `clearPendingLocalAgentInputsForChat`,
  `handleLocalAgentStream`.

Each edited site keeps the upstream import shape and gains a `// zapp: pro-removed`
comment naming the original specifier, so a merge conflict is legible.

#### Every stubbed site

| File | Former Pro module | Feature-off behaviour |
|---|---|---|
| `src/main.ts` | `local_agent/ai_messages_cleanup`, `local_agent/chat_search_indexer` | Retention sweep and chat-search indexer are no-ops |
| `src/ipc/ipc_host.ts` | `themes_handlers`, `visual_editing_handlers`, `local_agent/agent_tool_handlers` | Handlers still register (see below) |
| `src/ipc/handlers/chat_stream_handlers.ts` | `local_agent/chat_search_indexer`, `local_agent/local_agent_handler` | `handleLocalAgentStream` logs and returns `false` (upstream's "stream failed" signal), so quota accounting and error paths are unchanged |
| `src/ipc/processors/response_processor.ts` | `processors/search_replace_processor` | `applySearchReplace` returns `{ success: false }`, surfacing a clear per-file issue |
| `src/ipc/utils/chat_attachment_utils.ts` | `local_agent/tools/execute_sandbox_script` | Sandbox-script capability hint always off |
| `src/prompts/system_prompt.ts` | `main/prompts/turbo_edits_v2_prompt` | Prompt suffix is the empty string |
| `src/hooks/useAgentTools.ts` | `local_agent/tool_definitions` | `AgentToolName` widened from a name union to `string` |
| `src/components/chat/DyadSearchReplace.tsx` | `shared/search_replace_parser` | Parses to `[]`; the card falls back to rendering raw content |
| `src/components/preview_panel/PreviewIframe.tsx` | `ui/components/Annotator/Annotator` | The `userBudget ? <Annotator/> : <AnnotatorOnlyForPro/>` ternary collapses to the existing non-Pro fallback, which upstream already ships |

IPC channels the UI touches are registered with empty results rather than left
unregistered, so the renderer degrades instead of throwing "No handler registered":
`get-themes`, `get-custom-themes`, `get-theme-generation-model-options` and
`agent-tool:get-tools` return `[]`; `get-app-theme` returns `null`. The mutating theme,
visual-editing and agent-consent channels reject with a typed
`DyadError(Precondition)`.

#### Pro-dependent tests the import sweep could not see

The deletions below were found by grepping for `src/pro` import specifiers. That sweep
is **necessary but not sufficient**: a test can depend on Pro *behaviourally*, by
driving a chat turn through `hybrid_chat_harness` and asserting on a card that only a
Pro tool renders, without importing anything from `src/pro`.

`src/ipc/handlers/__tests__/local_agent_*.integration.test.*` (13 files) are the known
population — e.g. `local_agent_list_files` waits for `[data-testid="dyad-list-files"]`,
which `handleLocalAgentStream` no longer emits. They fail by construction and cannot be
made green while the agent loop is stubbed. They are **left in place, red**, until MAC-6
replaces the agent loop and can say which are worth rewriting against zapp's own
implementation. Deleting them now would destroy the specification of behaviour MAC-6
has to reproduce.

Nothing depends on them being green: `@zapp/desktop` contributes no turbo tasks, so they
are outside CI. Before treating a desktop test failure as a regression, check it against
this list.

#### Deleted tests

Six test/eval files exercised only Pro code and were deleted whole (a deletion is a
trivially resolvable merge conflict; a rewritten test is not):

- `src/components/chat/explore_chat_history_streaming.integration.test.tsx`
- `src/ipc/handlers/__tests__/local_agent_consent.integration.test.tsx`
- `src/__tests__/evals/tool_use.eval.ts`
- `src/__tests__/evals/chat_history.eval.ts`, `plumbing_check.eval.ts` and their shared
  `helpers/chat_history_harness.ts`

### Two upstream fixtures need `git add -f`, forever

Two files that upstream tracks are matched by gitignore rules here and were silently
dropped from the first vendoring commit — `git status` cannot see them, so nothing
warns you:

| File | Swallowed by |
|---|---|
| `apps/desktop/e2e-tests/fixtures/import-app/context-manage/.env.foobar` | root `.gitignore` `.env.*` |
| `apps/desktop/e2e-tests/fixtures/import-app/minimal-with-dyad/.dyad/plans/test-plan.md` | the fixture's own nested `.gitignore` `.dyad/` |

Both are deliberately "ignored-looking": they are fixtures *for* tests that assert
ignored files are handled correctly, so upstream force-adds them too. They must be
re-added with `git add -f` after every merge that touches them.

Because gitignore-swallowed files are invisible to `git status`, the merge checklist
below includes a tracked-file **count** diff against the upstream tree — that is the
only cheap check that catches this class.

### Making the fork build under pnpm

Dyad ships an npm `package-lock.json` and assumes npm's flat `node_modules`. Under
pnpm's isolated layout the vendored tree needs four adjustments. All are inside
`apps/desktop/`.

1. **`package-lock.json` deleted.** The workspace resolves through the root
   `pnpm-lock.yaml`.

2. **Undeclared transitive imports promoted to direct dependencies.** Upstream imports
   packages it never declares, relying on npm hoisting. pnpm's strict linking surfaces
   them as build failures. Added, at the versions upstream's own lockfile ships:
   `@shikijs/langs`, `@shikijs/themes`, `@ai-sdk/provider`, `pg`, `node-fetch`,
   `fs-extra` (runtime) and `@types/hast`, `@testing-library/dom`,
   `@testing-library/user-event`, `playwright`, `@electron-forge/maker-base`,
   `@electron-forge/shared-types`, `@electron/packager`, `@electron/windows-sign`
   (build/test time). Purely additive, so merges are trivial.

3. **Three deps pinned to upstream's locked versions.** Without `package-lock.json` the
   caret ranges drift into minors that break upstream's *own* types:
   `@vercel/sdk` 1.18.0, `@neondatabase/api-client` 2.7.1, `@tanstack/react-router`
   1.131.36. Drop these pins whenever upstream bumps the ranges.

4. **`apps/desktop/.npmrc` declares `hoist-pattern[]=*`.** Electron Forge's
   `checkSystem` refuses to run under pnpm unless `node-linker`, `hoist-pattern` or
   `public-hoist-pattern` is set. It probes with `pnpm config get` from the package
   directory, so the value is scoped here. `*` is pnpm's own default, so the workspace
   layout is unchanged and every other package keeps strict isolated `node_modules`.
   (A per-package `node-linker=hoisted` was tried and does not work — pnpm only honours
   that at the workspace root.)

   The guard is bypassed deliberately and only far enough to run `start`. It is
   *correct* about packaging — see below.

Additionally, `vite.renderer.config.mts` sets `resolve.preserveSymlinks: false`.
`@electron-forge/plugin-vite` hardcodes `preserveSymlinks: true` for the renderer,
which assumes a flat `node_modules`; under pnpm every dependency is a symlink into the
virtual store, so esbuild resolved transitive imports from the *link* path and failed
with ~600 "Could not resolve" errors. Forge merges user config last, so the override
wins.

### Coexisting with turbo without being wired into it

Dyad's script names collide with root turbo task names, and its `build` is a full
Electron package — far too heavy for `turbo run build`. Four scripts are renamed so
`@zapp/desktop` contributes **zero** tasks to the root graph:

| upstream | here |
|---|---|
| `build` (= `pre:e2e`, an Electron package) | `build:e2e` |
| `test` | `test:unit` |
| `lint` (`oxlint --fix`, mutates files) | `lint:oxlint` |
| `dev` (persistent Electron) | `dev:electron` |

`presubmit` was updated to call `lint:oxlint`. Root `pnpm lint` / `typecheck` / `test`
therefore behave exactly as before this change. Renaming beats filtering because it
keeps root `package.json` and `turbo.json` untouched. Wiring real tasks in is deferred
until the desktop app has zapp-owned code worth gating (MAC-2+).

`engines.node` was relaxed from `>=24 <26` to `>=22` to match the monorepo baseline
(root `engines`, `.nvmrc`), since the root `.npmrc` sets `engine-strict=true`.

`apps/desktop/` was added to the root `.prettierignore`: root `pnpm format` runs
`prettier --write .` and would otherwise reformat the whole vendored tree, destroying
merge fidelity.

The vendored `.claude/` directory was deleted. Its 23 Dyad-specific skills were being
registered globally in this repo's agent tooling. `.cursor/`, `.agents/`, `.github/`,
`AGENTS.md` and `CLAUDE.md` are kept — they are inert here and only apply within
`apps/desktop/`.

### Packaging needs a hoisted install; `start` does not

`@electron/packager` walks production dependencies with `flora-colossus`, which looks
for every transitive dependency *flat* inside `apps/desktop/node_modules`. pnpm's
isolated linker puts them in the virtual store instead, so packaging fails at the
**Copying files** step:

```
Failed to locate module "@smithy/eventstream-codec"
  from ".../apps/desktop/node_modules/@ai-sdk/amazon-bedrock"
```

The module is present and Node resolves it fine — the walker just cannot see it. Every
earlier step (all five Vite production bundles, `generateAssets`, `prePackage`) passes,
so this is purely a `node_modules` layout interaction, unrelated to the de-Pro work.

Packaging therefore runs against a standalone hoisted install:

```sh
pnpm --filter @zapp/desktop run install:packaging   # standalone, node-linker=hoisted
cd apps/desktop && E2E_TEST_BUILD=true pnpm exec electron-forge make
```

This is scoped to `apps/desktop/node_modules` — it does not touch the root store or any
other package. `pnpm install` from the root restores the workspace layout afterwards.
The lockfile it emits is gitignored: the root `pnpm-lock.yaml` stays the source of
truth.

**`install:packaging` rebuilds native modules against Electron's ABI, and pnpm's store
is hard-linked.** Forge's "Preparing native dependencies" step rebuilds `better-sqlite3`
and `node-pty` for Electron; because a hoisted pnpm install still hard-links into the
shared content-addressable store, that write lands on the *workspace* copy too. The
desktop unit tests then fail with `NODE_MODULE_VERSION 143 ... requires 127`. Repair:

```sh
pnpm rebuild -r better-sqlite3 node-pty
```

MAC-3 should either isolate the packaging tree from the shared store (`pnpm deploy`) or
make the rebuild part of a packaging script that restores Node ABI afterwards.

Two permanent alternatives, both **deferred to MAC-3** (which owns packaging and
signing): set `node-linker=hoisted` in the *root* `.npmrc`, or build the packaging tree
with `pnpm deploy`. Neither belongs in MAC-1, because the first changes dependency
resolution for every package in the monorepo.

`E2E_TEST_BUILD=true` is what selects the unsigned path: upstream's `forge.config.ts`
sets `osxSign`/`osxNotarize` to `undefined` for test builds. It also skips the
"Move to Applications Folder?" modal (`promptMoveToApplicationsFolder`), which
otherwise blocks window creation for an app run outside `/Applications`.

## Upstream-merge strategy

Merges are done as `git remote add dyad …; git fetch dyad --tags` and a subtree-style
merge of a new tag into `apps/desktop/`, then:

1. **Re-assert the licence boundary first.** Delete `src/pro/` from the incoming tree
   *before* resolving anything else, and re-run the two grep/find checks above. This is
   non-negotiable and comes before any build fixing.
2. **Diff the tracked-file count against the upstream tree.** Files swallowed by a
   gitignore rule never appear in `git status`, so a merge can silently drop them (this
   happened on the first vendoring — see the fixture table above). Against a clone of
   upstream at the merged SHA:

   ```sh
   git --git-dir=<upstream>/.git ls-tree -r --name-only <SHA> | grep -v '^src/pro/' | sort > /tmp/up.txt
   git ls-files apps/desktop | sed 's#^apps/desktop/##' | sort > /tmp/ours.txt
   comm -23 /tmp/up.txt /tmp/ours.txt   # upstream has, we do not — every line must be
                                        # an intentional deletion listed in this ADR
   comm -13 /tmp/up.txt /tmp/ours.txt   # ours only — expect just src/zapp/**
   ```

   Baseline at `282591c`: upstream 2415 tracked files excluding `src/pro`; we track
   2344 = 2415 − 66 (`.claude/**`) − 1 (`package-lock.json`) − 6 (Pro-only tests)
   + 2 (`src/zapp/pro_stubs/*`). **Zero unexplained.**
3. **Expect conflicts only where marked.** Every intentional divergence is one of:
   a `// zapp: pro-removed` comment, an additive `package.json` entry, a renamed script,
   or the `preserveSymlinks` block. Grep `// zapp:` to enumerate them.
4. **Re-stub new Pro import sites.** If upstream adds an import from `src/pro`, add the
   symbol to `src/zapp/pro_stubs/{shared,main}.ts` and repoint the site — do not inline.
5. **Re-check the undeclared-dependency list.** New upstream imports of undeclared
   transitives fail loudly at build; add them to `dependencies` at upstream's locked
   version rather than loosening pnpm.
6. **Keep zapp-authored code out of the vendored tree.** Per plan 09's constraint,
   zapp-specific code lives under `apps/desktop/src/zapp/*`, which upstream will never
   touch.
7. **Re-`git add -f` the two swallowed fixtures** if the merge touched them:
   `e2e-tests/fixtures/import-app/context-manage/.env.foobar` and
   `e2e-tests/fixtures/import-app/minimal-with-dyad/.dyad/plans/test-plan.md`.
8. **Before running the desktop tests**, build the nested fake LLM server, exactly as
   upstream CI does — every `*.integration.test.*` file fails at import without it:
   `cd apps/desktop/testing/fake-llm-server && npm install && npm run build`.

## Consequences

- The licence boundary is provable by two commands, and holds in history.
- Pro-backed surfaces are inert: local-agent chat modes, chat search, turbo edits /
  search-replace, themes, visual editing, the annotator canvas, and the agent tool
  registry. Local-agent chat modes are replaced wholesale in MAC-6; the rest are
  product decisions for MAC-2+.
- The fork type-checks cleanly: `npx tsgo -p tsconfig.app.json --noEmit` reports
  **0 errors**, once the nested `testing/fake-llm-server` project is installed. Without
  that install it reports 53 errors there (`Cannot find module 'express'` and the
  implicit-`any` cascade behind it) — an artifact of the missing install, not of this
  fork. See merge-checklist step 8.
- `pnpm --filter @zapp/desktop start` boots the app against the normal workspace
  install: main process ready, migrations run, GPU + renderer processes up, renderer
  driving IPC.
- `electron-forge make` produces an ad-hoc-signed (i.e. unsigned for distribution)
  `out/dyad-darwin-arm64/dyad.app` and
  `out/make/zip/darwin/arm64/dyad-darwin-arm64-1.9.0.zip`, but only after
  `install:packaging`. Making that a single command is MAC-3's job.
- Root `pnpm lint` / `typecheck` / `test` are unchanged: `@zapp/desktop` contributes no
  turbo tasks.
