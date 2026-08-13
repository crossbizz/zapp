# Legacy Completion Replay Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover pre-redaction in-flight completions without sending stored secrets, changing completion identity, or charging twice.

**Architecture:** Durable completion records carry a backward-compatible request version. Version 1 replays attach the original accounting fingerprint to a service-only recovery field; Model Gateway authenticates it, strips it before provider routing, and applies it only to the existing accounting identity.

**Tech Stack:** TypeScript, Zod, Fastify service tokens, Vitest, PostgreSQL-backed model-completion accounting.

## Global Constraints

- No model-provider calls outside `services/model-gateway`.
- No secret values in code, logs, events, fixtures, or committed environment files.
- Zod validates every service boundary; types are inferred from schemas.
- Mutating and billable operations keep stable idempotency identities.
- A failed check is never reported as success.
- Structural controls govern service-only recovery; string conventions do not.
- The public local-agent schema cannot express the recovery field.
- Review stops after two rounds; remaining load-bearing findings are re-scoped.

---

### Task 1: Versioned, accounting-stable legacy replay

**Files:**
- Modify: `services/orchestrator-worker/src/session/transcript.ts`
- Modify: `services/orchestrator-worker/src/session/loop.ts`
- Modify: `services/orchestrator-worker/test/session.test.ts`
- Modify: `services/model-gateway/src/schemas.ts`
- Modify: `services/model-gateway/src/app.ts`
- Modify: `services/model-gateway/src/usage-client.ts`
- Modify: `services/model-gateway/test/gateway.test.ts`
- Modify: `services/model-gateway/test/budget.test.ts`
- Modify only if type propagation requires it: internal gateway clients/tests
- Modify: completion plan, Plan 10, master execution log, and `tasks/todo.md`

**Interfaces:**
- Consumes: `InFlightCompletionSchema`, `CompleteRequestSchema`, Model Gateway service-token claims, `createUsageAccountedCompletion`.
- Produces: `requestVersion: 1 | 2` on durable in-flight records and optional strict `accountingReplay: { version: 1; requestFingerprint: string }` on internal complete requests.

- [ ] **Step 1: Add the worker replay regression**

Seed a durable version 1 request containing a redactor-registered value. Simulate
the request reaching a gateway claim before interruption. Resume and assert:
the same `completionId`, no registered value in provider-bound bytes,
`accountingReplay.version === 1`, and the exact original durable fingerprint.

- [ ] **Step 2: Run the worker test and confirm RED**

Run the single named Vitest case. It must fail because the current resumed
request has changed bytes without an accounting-compatible recovery identity.

- [ ] **Step 3: Add Model Gateway boundary regressions**

Cover four literal cases: `control-api` cannot send `accountingReplay`;
`orchestrator-worker` can; the provider backend receives no recovery field; and
the accounting client receives the original version 1 fingerprint while the
completion ID stays fixed.

- [ ] **Step 4: Run those cases and confirm RED**

Run the named gateway and budget cases. They must fail on missing schema,
authorization, stripping, or accounting-identity behavior.

- [ ] **Step 5: Implement the durable version boundary**

Parse missing `requestVersion` as `1`. Persist new requests as version `2` only
after applying final outbound redaction, then hash and store those exact bytes.
For version 1 only, attach `accountingReplay` with the stored original
fingerprint. Never mutate the legacy fingerprint or completion ID.

- [ ] **Step 6: Implement authenticated recovery in Model Gateway**

Add the strict optional recovery schema to the internal complete request and
omit it from `LocalAgentCompletionRequestSchema`. Reject the field unless the
verified caller service is `orchestrator-worker`. Strip the field in the HTTP
boundary before calling provider-backed completion. Pass it separately to the
usage-accounting wrapper, whose identity uses the supplied fingerprint only for
version 1 recovery.

- [ ] **Step 7: Prove post-claim replay and one-charge behavior**

Using the real accounting wrapper with a stateful fake accounting port, prove
completed recovery replays committed events without a second provider call and
expired recovery reclaims once under the original reservation. Assert the
provider request contains no recovery metadata or registered secret.

- [ ] **Step 8: Run GREEN and affected gates**

Run full orchestrator session tests, Model Gateway unit tests, Control API model
completion tests, contracts/model-gateway/orchestrator/control lint and
typecheck, architecture boundaries, and `git diff --check`. Provider tests skip
visibly when credentials are absent.

- [ ] **Step 9: Record and commit**

Mark Task 45 as re-scoped at its two-round cap, add and check
`OPS-12-FIX-2 Legacy completion replay redaction`, append accurate execution
logs, and commit with `fix(security): recover legacy completion replay safely`.

