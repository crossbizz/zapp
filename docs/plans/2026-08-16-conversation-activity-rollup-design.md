# Conversation Activity Rollup Design

**Status:** Approved 2026-08-16

## Problem

The conversation currently exposes nearly every `tool.started` and `tool.completed`
lifecycle event as a separate visible row. Non-rendered events such as `tool.output`,
`agent.started`, and `usage.recorded` also split otherwise related tool calls into
separate groups. A normal project setup therefore reads like an implementation log
instead of a useful progress update.

## Decision

Render one concise, semantic activity row for each uninterrupted batch of tool work.
Keep the exact lifecycle summaries available in a closed-by-default details disclosure.
Build the visible summary from structured tool names and audit metadata; do not parse
assistant prose or infer workflow state from chat text.

The browser remains a projection of the existing public event stream. No event schema,
API, orchestrator, sandbox, model-gateway, preview, or port behavior changes.

## Interaction

- File mutations roll up to `Updated 2 project files` from structured path and
  `filesChanged` audit metadata; repeated paths are counted once.
- Dependency installations roll up to `Installed 10 dependencies` when structured
  audit counts are available, otherwise `Installed dependencies`.
- Read-only discovery rolls up to `Reviewed project context`.
- Commands, preview operations, checks, and source-control work use similarly short,
  tool-family summaries.
- Mixed batches join at most three semantic summaries with ` · ` and collapse any
  additional categories into `Completed N more tasks`.
- A completed batch ends with `✓`, an active batch ends with `…`, and a failed batch
  displays the event's user-language failure summary with `!`. A `tool.completed`
  lifecycle event whose structured audit outcome is failed, timed out, or cancelled
  remains a visible failure rather than receiving a success checkmark.
- Each tool family is summarized from its own lifecycle state, so newly started work
  remains visible beside earlier completed work in the same batch.
- The disclosure label is `Details`; expanding it shows the original ordered
  `userSummary` lifecycle entries and states.
- Assistant/user messages, conversation cards, phase cards, and commit chips remain
  meaningful group boundaries. Non-rendered metadata and `tool.output` do not split
  activity batches.

## Accessibility

The semantic summary remains native `<summary>` content so the whole row is keyboard
operable. Failure state is communicated with text and punctuation, not color alone.
Expanded details remain an ordered list in event sequence.

## Verification

- A focused rendering test proves semantic rollups, pluralization, failure prominence,
  and closed-by-default raw details.
- The seeded conversation browser test includes real `tool.output` events and proves
  they do not create extra visible activity rows.
- Web lint, typecheck, focused Node tests, the focused Playwright regression, and the
  production web build must pass before integration.
