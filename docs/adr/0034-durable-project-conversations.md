# ADR-0034: Durable project conversations

**Status:** Accepted (product owner approval, 2026-08-16)

## Context

The product currently exposes an agent run as if it were a chat thread. A terminal follow-up creates another immutable run, but the web client selects only the newest run, which makes prior messages unreachable. Messages accepted while a Builder activity is busy are durable workflow signals, but the activity cannot observe them until it returns and the client has no structured applied acknowledgement.

Projects also need multiple explicit chat threads without weakening the immutable run, billing, verification, or audit boundaries.

## Decision

A conversation is a tenant-scoped durable aggregate above immutable agent runs. Each run has a required conversation identity and positive order within that conversation, and a partial unique index permits at most one active run per conversation.

Public `/v1` APIs expose project conversation summaries and structured cross-run event history. Creating a run without a conversation creates a new conversation atomically; creating one with a terminal conversation creates its successor. The control plane builds a bounded immutable prior-context artifact for that successor. Existing runs are migrated into one deterministic conversation each without rewriting their events or accounting records.

Builder session transcripts are persisted by run and task so a session can yield after a completed tool boundary. A queued message is applied once at the next safe boundary and acknowledged through the structured `message.applied` event. Tools are not cancelled to accept messages.

The browser keeps conversation selection in the URL, offers explicit **History** and **New thread** controls, and renders every run in the selected conversation. A new thread is not persisted until its first message creates the conversation and run.

Project-card deletion remains a separate UI task and reuses the existing CP-17 owner-only asynchronous deletion API.

## Consequences

- Run identity remains the unit for execution, billing, verification, Git, and audit data.
- Conversation history works across browsers and clients through the public API and generated SDK.
- Separate conversations cannot inherit context accidentally; only a successor in the same conversation or the existing explicit fork operation can do so.
- The migration and every conversation query remain tenant-scoped, additive, and keyset-paginated.
- The web client may optimistically display an accepted user message, but it cannot call it applied until the matching structured event arrives.
- Conversation rename, deletion, search, bookmarks, sharing, and desktop presentation parity remain out of scope.

## References

- `docs/superpowers/specs/2026-08-16-durable-project-conversations-design.md`
- `docs/superpowers/specs/2026-08-16-project-card-deletion-design.md`
- `docs/superpowers/plans/2026-08-16-durable-project-conversations.md`
- `docs/superpowers/plans/2026-08-16-project-card-deletion.md`
