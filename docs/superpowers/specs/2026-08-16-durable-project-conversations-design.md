# Durable Project Conversations Design

**Status:** Approved by the product owner on 2026-08-16. The product owner delegated remaining implementation decisions and requested no further questions.

## Problem

The builder currently treats an agent run as both an execution record and a conversation. The database retains every run, but the web client always selects the newest run, so earlier messages become unreachable. Sending a message after a terminal run creates a new run and replaces the visible transcript. Sending during a long-running Builder activity is accepted and persisted, but the workflow cannot apply the queued message until that activity returns, and the UI exposes no queued state.

The required product behavior is different:

- a project owns multiple durable conversation threads;
- one thread may span multiple agent runs;
- messages sent in the same thread keep all earlier messages visible and available as agent context;
- a separate thread starts only when the user explicitly chooses **New thread**; and
- a message accepted while the agent is busy becomes visibly queued and is applied at the next safe tool boundary.

## Chosen architecture

Introduce a first-class `conversations` control-plane entity. An agent run remains one bounded, billable, verifiable execution, while a conversation is the user-facing thread that groups one or more runs.

This design rejects two shortcuts:

- React or `localStorage` grouping is not durable across clients and violates API-first.
- Reopening a terminal run would blur immutable execution, billing, task, and verification boundaries.

### Persistence

Add a tenant-scoped `conversations` table with:

- `id` (`conv_*`) as the product identifier;
- `organization_id`, `project_id`, and `created_by`;
- `title`, initialized from the first user message using a deterministic bounded projection;
- `created_at` and `updated_at`; and
- a composite tenant foreign key to the project.

Add required `conversation_id` and positive `conversation_run_number` columns to `agent_runs`. A unique `(conversation_id, conversation_run_number)` index fixes run order. A partial unique index permits at most one active run (`queued`, `running`, `paused`, or `waiting_for_approval`) per conversation.

Migration compatibility is mandatory: every existing run receives its own deterministic conversation and run number `1`. No existing run, event, artifact, billing row, or Git reference is rewritten or discarded.

### Public API

All new capability is exposed under `/v1` and generated into `@zapp/api-client` before the browser consumes it.

1. `GET /v1/projects/:projectId/conversations`
   - keyset-paginated newest-activity-first summaries;
   - each item contains conversation identity, title, timestamps, latest run identity/status, and run count;
   - cross-tenant project IDs return 404.

2. `GET /v1/conversations/:conversationId/events`
   - keyset-paginated, user-visible structured events across all runs in deterministic `(conversation_run_number, run_sequence)` order;
   - internal/support-only events never cross the boundary;
   - event identity is the pair `(runId, sequence)`, so equal per-run sequence values cannot collide.

3. `POST /v1/projects/:projectId/runs`
   - accepts an optional `conversationId`;
   - omission atomically creates a new conversation and its first run;
   - supplying a terminal conversation creates its next run in that conversation;
   - supplying a conversation with an active run returns typed `409 conversation_run_active` instead of creating concurrent writers;
   - existing idempotency, tenant isolation, RBAC, plan limits, and audit requirements remain binding.

4. `message.applied` AgentEvent
   - payload: `{ messageId, operationKey }`;
   - emitted by the workflow only after the durable session transcript incorporates the accepted `message.user` event;
   - lets every client distinguish queued from applied without parsing prose.

Conversation creation is intentionally folded into run creation. Clicking **New thread** does not create empty server records; the first submitted message creates the conversation and run atomically.

### Same-thread context

When a terminal conversation receives a follow-up, the control plane creates the next run and a bounded context artifact derived from the prior runs' structured user/assistant messages and referenced artifacts. The artifact records the source conversation and terminal source run. The new workflow input references that immutable artifact, and the existing context builder includes it before the new prompt.

Context construction is server-owned, tenant-scoped, and bounded by the existing context budget. The browser never concatenates historical chat text into a prompt. Separate conversations never share context unless the explicit existing conversation-fork operation is used.

### Safe application of messages during work

The current activity-local heartbeat transcript must become durable across successive Builder-session activities. Store the versioned transcript behind a run/task-scoped transcript repository. Heartbeats remain the retry checkpoint, while the repository permits a completed safe yield to resume in a new activity without replaying the first model turn.

Builder sessions yield after each completed tool boundary. A Temporal signal received during an active model/tool operation is appended to the workflow's keyed queue. At the next safe boundary, the next session activity loads the durable transcript, applies the oldest queued message exactly once, emits `message.applied`, and continues. Active tools are never cancelled merely to accept a message.

The queue remains bounded at 100 messages. Duplicate operation keys are ignored. A full queue fails explicitly; it cannot silently drop a message.

## Web experience

The project header gains accessible **History** and **New thread** controls.

### History drawer

- Lists conversation summaries by title, last activity, and latest status.
- Highlights the selected conversation.
- Loads older pages on demand without duplicates.
- Selecting an item updates `?conversation=<conv_id>` using normal browser history.
- Refresh, Back, and Forward restore that selection.
- An invalid or foreign conversation falls back to a truthful not-found state, not the newest thread.

The newest conversation is selected only when the URL contains no conversation selection. The transcript renders every event page for the selected conversation, then merges the latest active run's existing SSE stream by `(runId, sequence)`.

### New thread

Choosing **New thread** changes the URL to `?conversation=new`, clears the transcript and run state, focuses the composer, and preserves project-level mode/model preferences. The first successful send creates and selects the new conversation. Cancelling or navigating away before sending creates no record.

### Same-thread follow-up

- Active latest run: use the existing keyed message continuation route.
- Terminal latest run: create the next run with the selected `conversationId`.
- The preceding transcript stays mounted while the successor starts.
- The accepted user bubble appears immediately with **Queued**.
- `message.applied` changes the bubble to **Applied**; the marker may disappear after the next assistant response, but queued state must never be hidden prematurely.

### Component boundaries

Split the current oversized `Thread.tsx` only along responsibilities needed here:

- `useProjectConversations` owns summary pagination and URL selection.
- `useConversationEvents` owns paginated history plus active-run SSE merge.
- `ConversationHistoryDrawer` renders history and new-thread actions.
- `Thread` renders one selected conversation and submits messages.

No unrelated builder or preview redesign is in scope.

## Error handling

- Conversation-list failure keeps the active thread visible and gives the drawer a Retry action.
- Historical-event failure does not replace successfully loaded pages; retry resumes from the failed cursor.
- A terminal-follow-up race that receives `conversation_run_active` refreshes the conversation and sends to the authoritative active run with a deterministic child idempotency key derived from the original send operation. The original key is never reused across different routes or request bodies.
- Message acceptance failure preserves the draft and attachments and shows the existing truthful retry error.
- Context-artifact creation failure leaves no run or conversation mutation committed.
- Transcript persistence failure stops at the safe boundary and marks the run failed; it never starts from an empty transcript.
- Every foreign project, conversation, run, and event read returns 404.

## Tests and acceptance

### Database and control plane

- Migration backfills one conversation per existing run without changing event/billing counts.
- Tenant repository tests prove ordered runs, conversation pagination, and foreign-ID 404 behavior.
- Concurrent follow-up creation proves the partial unique active-run constraint and stable idempotent replay.
- Conversation history returns only user-visible events in deterministic cross-run order.
- New OpenAPI operations and `message.applied` are additive and generated SDK tests compile.

### Orchestrator

- A signal arriving during a blocked tool remains queued until the tool completes.
- The safe yield persists the transcript; the next activity applies the message once and does not replay the first model turn or tool.
- Crash/retry around transcript persistence and `message.applied` emission remains idempotent.
- Queue overflow and duplicate operation keys are explicit and deterministic.
- A successor run receives bounded prior-conversation context; a separate conversation does not.

### Web

- History shows all seeded conversations and restores an older selection after reload.
- A selected conversation renders messages from multiple runs in order.
- Sending after a terminal run retains old messages and adds the successor run to the same history item.
- New thread creates a distinct history item only after first send.
- A busy-agent message visibly transitions from Queued to Applied.
- Back/Forward restores conversation selection without duplicate SSE connections.
- Organization switching cannot leak or retain another tenant's selected conversation.

### Verification gate

Run focused database, contract, control-api, API-client, orchestrator, and web tests; touched-package lint, typecheck, and build; the web Playwright conversation suite; then the repository verification command required by the owning execution task. Real-provider verification runs once at the final task acceptance gate only if the final plan declares it necessary.

## Scope exclusions

- User-renamable conversation titles, bookmarks, search, deletion, and sharing.
- Merging two conversations.
- Token-by-token assistant deltas.
- Changes to desktop presentation beyond keeping its generated API and structured-event types compiling; desktop conversation UX remains a later parity task.
