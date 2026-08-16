# Conversation Activity Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace noisy per-tool conversation rows with concise semantic activity batches while preserving exact lifecycle summaries behind collapsed details.

**Architecture:** Keep the existing public `AgentEvent` stream unchanged. Extend the browser's activity projection with structured tool metadata, summarize tool families in `ToolActivityLine`, and make `Thread` flush activity only at events that render a distinct thread item.

**Tech Stack:** TypeScript, React 19, Next.js 15, Node test runner, Playwright.

## Global Constraints

- Consume structured `AgentEvent` fields only; never parse assistant prose for state.
- Keep raw lifecycle summaries accessible in a closed-by-default native disclosure.
- Never hide a failed tool summary behind a successful aggregate.
- Do not change E2E ports, public APIs, event schemas, orchestration, or preview behavior.
- Follow strict TDD: observe the focused regression fail before changing production code.

---

### Task 1: Concise conversation activity batches

**Files:**
- Modify: `apps/web/src/components/conversation/ToolActivityLine.tsx`
- Modify: `apps/web/src/components/conversation/Thread.tsx`
- Modify: `apps/web/test/conversation-presentation.test.ts`
- Modify: `apps/web/e2e/conversation.spec.ts`
- Modify: `docs/plans/08-web-ux.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Consumes: existing `RunEvent.data.payload.tool`, `toolCallId`, `userSummary`, and optional `audit.count` fields.
- Produces: `ToolActivity` records with `tool`, `toolCallId`, optional `count`, `summary`, `state`, and `sequence`; `ToolActivityLine` renders one semantic summary plus collapsed ordered details.

- [ ] **Step 1: Write the failing rendering tests**

  Add real server-rendered `ToolActivityLine` assertions showing that two completed
  `write_file` calls and two dependency installs render
  `Updated 2 project files · Installed 10 dependencies ✓`, that `<details>` is closed,
  and that raw lifecycle summaries remain in the ordered list. Add a separate failure
  assertion proving a failed event's `userSummary` is the visible summary.

- [ ] **Step 2: Run the focused rendering test and confirm RED**

  Run:
  `pnpm --filter @zapp/web exec tsx --test test/conversation-presentation.test.ts`

  Expected: FAIL because the current component joins every completed `userSummary`
  instead of producing semantic rollups.

- [ ] **Step 3: Implement the minimal semantic summarizer**

  Extend `ToolActivity` with structured tool metadata. Add focused helpers that group
  completed activities into file, dependency, inspection, command, preview, check,
  source-control, and fallback categories. Prefer a failed activity summary whenever
  one exists. Render the aggregate and a `Details` label in `<summary>` while keeping
  the exact lifecycle entries in the ordered list.

- [ ] **Step 4: Run the focused rendering test and confirm GREEN**

  Run:
  `pnpm --filter @zapp/web exec tsx --test test/conversation-presentation.test.ts`

  Expected: all conversation presentation tests pass.

- [ ] **Step 5: Write the failing stream-grouping browser regression**

  Update the seeded conversation fixture with `toolCallId`, `tool.output`, multiple
  file writes, and dependency audit counts. Assert one activity disclosure is visible,
  its semantic summary is correct, and the raw entries appear only after expansion.

- [ ] **Step 6: Run the focused browser regression and confirm RED**

  Run with explicit non-conflicting existing environment overrides:
  `ZAPP_WEB_E2E_APP_PORT=3110 ZAPP_WEB_E2E_API_PORT=4110 pnpm --filter @zapp/web exec playwright test e2e/conversation.spec.ts --grep "reduces the seeded stream"`

  Expected: FAIL because `tool.output` and non-rendered lifecycle metadata split the
  activity batch.

- [ ] **Step 7: Implement the minimal stream grouping change**

  In `Thread`, capture structured tool metadata for lifecycle events. Flush activity
  before messages, cards, phases, commits, or a different run's tool activity; ignore
  non-rendered events as grouping boundaries.

- [ ] **Step 8: Run focused tests and confirm GREEN**

  Run the rendering test and focused Playwright command from Steps 4 and 6.

- [ ] **Step 9: Verify the affected web package**

  Run:
  `pnpm --filter @zapp/web lint`
  `pnpm --filter @zapp/web typecheck`
  `pnpm --filter @zapp/web build`

  Expected: each command exits 0. Do not change port configuration if unrelated E2E
  work is active; retry the focused browser command with the explicit overrides.

- [ ] **Step 10: Record and commit the task**

  Add checked `WEB-6-FIX-1` entries to `tasks/todo.md` and Plan 08, append the dated
  execution-log evidence, then commit all task files with:
  `fix(web): collapse conversation tool activity`

