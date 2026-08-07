# ADR-0011: AR-5 injection defense is structural, not linguistic

- Status: Accepted
- Date: 2026-08-06
- Owners: agent runtime / security
- Approval: controller decision under the user's delegated decision authority, 2026-08-06
- Affects: `packages/agent-policies` (AR-5), AR-6 (blocked on it), OPS-13 corpus, plan 04 review rubric
- References: PRD §16.3, §25.4, §31.2, §31.3; master Global Constraints 2/15; plan 03 WS-11; plan 10 OPS-13; AR-4 registry

## Context

AR-5's brief asks for a **pure** `evaluateToolCall` with a small **blocklist** of
catastrophic shell shapes (`rm -rf /`, `curl | sh`, fork-bomb), a small destructive-SQL
pattern set that triggers **approval**, a `wrapUntrusted` delimiter, and a **10-string**
unit eval. The ≥25-payload corpus is explicitly OPS-13's, at M5. None of that is a custom
natural-language engine.

Two blocked branches built one anyway. `task/AR-5` and `task/AR-5-resume` carry
`risk.ts` at **1,245 lines** and `injection.ts` at **515 lines** — ~1,760 lines of policy
for a task the brief scoped at a few hundred. The blocker log records what they became:
an exhaustive shell-expansion/`eval`/positional-parameter/recursive-subshell command
grammar; a PostgreSQL identifier parser handling combining marks and astral-plane
codepoints; and an English classifier inferring intent from "grammatical and multi-action
directives" and "documentation polarity." Five capped review rounds on each left reproduced
P1 bypasses in all three, and the cap correctly halted the merge.

The failure is a category error committed on **both** sides of the review loop:

- The implementer built *completeness* into heuristics whose problems are undecidable in
  general — you cannot enumerate every shell expansion or every English phrasing of "also
  deploy this."
- The reviewer scored each newly-found bypass as **P1**, though the architecture never
  depended on those heuristics for containment. A bypass of a speed-bump is not a hole in
  the wall.

The actual boundary already exists and is structural. Plan 03 WS-11 puts command/egress
containment in Modal's **gVisor** sandbox behind **network-policy profiles**
(`restricted_verification` = deny-all), and *already labels the string-level guards
"defense in depth."* PRD §31.2 names gVisor and network profiles as the mandatory
controls; PRD §31.3 requires high-risk actions "evaluated outside the model" and
"repository instructions cannot change platform safety policy" — neither of which requires
parsing what a repository *said*. The branch inverted the design: it treated the heuristic
as the boundary and the boundary as an afterthought.

## Decision

**AR-5's boundary is structural and lives in code; its string heuristics are best-effort
signals that are explicitly not required to be complete.** One decision, five consequences:

1. **The containment controls are structural, evaluated outside the model:** per-mode tool
   allowlist + RBAC (AR-4 registry + approval policy); human-approval gates on
   deploy/rollback/destructive-migration (PRD §16.3/§25.4); the gVisor + WS-11
   network-profile sandbox as the real limit on what a shell command can reach; secrets
   not model-callable (AR-4). These are what must be correct.

2. **Injection defense is provenance gating, not language parsing.** `wrapUntrusted(text,
   source)` delimits and *tags* untrusted context (repo file, web fetch, tool output).
   `evaluateToolCall` denies or gates a **consequential** tool when the turn's context
   carries untrusted-provenance content — regardless of what that content says. This
   satisfies "repository instructions cannot change platform safety policy" (§31.3)
   structurally: the README does not need to contain "ignore your instructions" to be
   distrusted; being untrusted-provenance next to a `deploy_release` is sufficient.

3. **The command policy is the brief's small blocklist of catastrophic shapes, as a
   speed-bump — not an allowlist, not an exhaustive parser.** A coding agent must run
   arbitrary build tooling (`pnpm install`, custom scripts, migrations); a command
   *allowlist* would break the product on the first project-defined script, so it is
   rejected. Completeness of the blocklist is a **non-goal**: the sandbox is the boundary,
   the blocklist only stops the obvious foot-guns early.

4. **Destructive-SQL detection is the brief's small pattern set → `require_approval`,
   failing toward "ask."** A missed obfuscation is not a breach: production migrations
   require human approval regardless (§25.4), so the pattern only decides auto-approve vs.
   ask, and erring toward ask is safe.

5. **The corpus stays 10 strings at AR-5; ≥25 lives at OPS-13 (M5), already planned.**
   Public probe lists (garak, AgentDojo, OWASP LLM Top 10) are borrowed as OPS-13 **test
   data**. This is data, not runtime code, and carries no supply-chain surface.

**Review-rubric change (this is the half that stops the 14-round loop):** a demonstrated
bypass of a heuristic that the architecture does not rely on for containment is at most
**Minor**. Block only on a gap in a structural control (1). "Here is another shell
expansion / Unicode identifier / English phrasing that slips past the pattern" is expected
and acceptable, because the pattern is not the wall.

Rejected alternatives:

- **Exhaustive shell-grammar command policy.** Undecidable, non-terminating under review
  (both branches proved it), and the wrong layer — the sandbox already contains the blast
  radius the parser was trying to reason about.
- **Natural-language intent / documentation-polarity classifier.** Unbounded, and a soft
  form of letting repository prose drive safety policy, which §31.3 forbids in spirit.
  Provenance gating gives the same guarantee without reading the prose.
- **A runtime OSS guardrail dependency (`@llm-guardrails` et al.) in the deny path.** Adds
  a third-party dependency and its supply-chain/review surface to a security-critical code
  path, and any LLM-classifier mode cannot sit in a *blocking* decision (Global Constraint
  15; policy decisions in code, not delegated to a model). Permitted only as a
  **non-blocking signal**; for the ~50-line pattern scan, a **vendored pattern list** is
  preferred over a runtime dependency. (Borrowing OSS *probe corpora* as OPS-13 test data
  is unaffected — that is data.)

## Consequences

**Easier.** AR-5 collapses to roughly its briefed size, and AR-6 — which needs
`evaluateToolCall` plus the AR-4 registry and is currently blocked on this — unblocks. The
review loop terminates, because incompleteness of a heuristic is no longer a defect.

**Harder / accepted.** The string heuristics *will* have bypasses, by construction, and we
are choosing to ship them. That is only safe because containment is structural — which
makes one dependency load-bearing: **AR-5's command speed-bump is not sufficient alone and
must always be paired with the WS-11 network-profiled sandbox.** If any execution path ever
runs a model-generated command *outside* a network-profiled gVisor sandbox, that is a real
hole this ADR does not cover, and it is a structural-control gap (block-worthy), not a
heuristic gap.

**Work this creates.** The AR-5 brief in plan 04 is amended to point here and to state
completeness is a non-goal; the AR-5 review dispatch must carry the rubric change above so
the next round does not re-block on bypasses. `task/AR-5` and `task/AR-5-resume` are
abandoned, not merged; the rewrite starts from the amended brief.

**Exit conditions.** Revisit if a real incident (surfaced via OPS-13's growing corpus)
shows provenance gating is too coarse — approving so often it trains users to rubber-stamp,
or gating so rarely a consequential tool fired on untrusted context. The corpus is the
feedback channel; the response is tuning the *provenance* rule, not resurrecting the NL
parser.
