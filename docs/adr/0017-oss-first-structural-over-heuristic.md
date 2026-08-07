# ADR-0017: OSS-first for solved problems; structural controls over completeness heuristics

- Status: Accepted
- Date: 2026-08-06
- Owners: controller / all workstreams
- Approval: controller decision under the user's delegated decision authority, 2026-08-06
- Affects: WS-10, VF-14, VF-11, AR-11/AR-16/AR-20, AR-1 (retrospective), the plan-04/05 review rubric, AGENTS.md
- References: ADR-0016; master Global Constraints 2/15/16; plan 03 WS-10/WS-11, plan 04 AR-1/AR-5, plan 05 VF-11/VF-14

## Context

Three of the tasks that hit the five-round review cap — AR-1, AR-5, WS-10 — failed the
same way, and it is worth naming the shape because more tasks are queued into it.

- **AR-5** (blocked): built an exhaustive shell grammar + astral-plane SQL parser + English
  intent classifier. Re-scoped by ADR-0016.
- **AR-1** (marked done, by brute force): the Global-Constraint-2 boundary — "no
  model-provider calls outside `services/model-gateway`" — was enforced by a bespoke
  analyzer of JavaScript mutation semantics (live accessors, closures, prototypes,
  opaque mutation), landing **182 architecture tests**. It passes, but it is a static
  analysis of an undecidable property (dynamic dispatch can always hide a load), carrying
  permanent comprehension and maintenance cost, to enforce what is really a *coding*
  convention.
- **WS-10** (blocked, blocking WS-2): hand-wrote an HTML scanner to inject one
  `<script>` before `</head>`; the cap left it unable to handle unquoted `src` attributes
  and `<style>` raw-text — i.e. it was re-implementing an HTML parser and losing.

The common failure is **chasing completeness on an open-ended or undecidable input**
(every shell expansion, every Unicode identifier, every JS mutation path, every HTML edge
case), amplified by a review rubric that scored each newly-found bypass as **P1** even when
the architecture never depended on that heuristic for its guarantee.

This is a bounded family, not a verdict on the plan. The plan already leverages OSS heavily
and correctly — Forgejo, Temporal, Stytch, Flexprice, Grafana/OTel, Drizzle, Playwright,
gitleaks, osv-scanner, knip, ts-morph, axe-core, Semgrep, dagre — and the verification
gates correctly wrap `tsc`/`eslint`/`vitest`/`playwright` rather than reinventing them. The
over-build is concentrated in ~5 tasks that share the failure above.

## Decision

Three standing rules, applied to every remaining task:

**1. OSS-first for solved problems.** Do not hand-build what a maintained library or a
declarative rule already does. Specifically:

| Problem | Do NOT hand-build | Use |
|---|---|---|
| Inject/rewrite HTML in the preview proxy (WS-10) | a regex/hand HTML scanner | **`parse5`** — spec-compliant and Node-native, which the in-sandbox proxy is (plan 03 stack: Node + `http-proxy`). **Not** `HTMLRewriter`: that is a Cloudflare *Workers-runtime* API and `lol-html` is Rust; only the `html-rewriter-wasm` binding runs on Node, so treat it as a secondary option to evaluate, never the assumed default. Injection before `</head>` is a solved, tested operation either way |
| "No provider/SDK import outside service X" (AR-1, GC-2) | a JS-semantics analyzer | a Semgrep/ESLint import-ban rule (same shape as the shipped `no-dyad-pro-imports` rule and the license-boundary grep) **plus** the real control: provider keys exist only in that service's env (GC-5), so imported-elsewhere code has nothing to call |
| Unused deps, empty catch, TS errors (VF-14) | custom detectors | `knip`, ESLint `no-empty` (already enabled), `tsc` (already a gate) |
| Code duplication (VF-14) | an "80% token-similar" heuristic | `jscpd` structural clone detection, or drop to a Minor signal |
| Task/plan DAG scheduling (AR-11) | a bespoke scheduler | `graphlib` topological sort — **neither `graphlib` nor `dagre` is installed today** (`dagre` is only *planned*, for WEB-9 graph layout); verify availability before assuming either, rather than inheriting this row as fact |
| Injection / attack test corpora (OPS-13) | invented payloads | borrow `garak` / AgentDojo / OWASP LLM Top-10 probes as **data** |

Build custom only where the value is genuinely zapp-specific: tenant scoping,
`evaluateToolCall`, the verifier decision, the evidence manifest, the durable workflows.

**2. Structural over heuristic** (ADR-0016, generalized). The guarantee lives in a
structural control evaluated in code — credential scoping, sandbox/network profile,
approval gate, tool allowlist, a declarative lint rule. String / NL / AST / HTML heuristics
are **best-effort signals whose completeness is a non-goal**. If correctness depends on a
heuristic being complete, the design is wrong; move the guarantee to a structural control
and let the heuristic be a speed-bump.

**3. Review rubric** (now standing; added to AGENTS.md). A demonstrated bypass of a
heuristic the architecture does **not** rely on for containment is at most **Minor**. Block
only on a gap in a structural control or a genuine correctness/security defect.

**This is not a loophole, and the distinction is load-bearing.** A *heuristic-completeness*
finding is "here is another shell expansion / Unicode identifier / HTML edge case the
pattern misses" — expected by design, Minor. A *real defect* is a race, a wrong error code,
a resource leak, a lost write, or a bypassed structural control — blocking, at full
severity. The concurrent AR-3 and AR-4 findings are the reference examples of the second
kind: a cancellation race before listener registration, `apply_patch` overwriting a
concurrent change, a durable recorder that commits then reports `provider_error` instead of
`usage_accounting_failed`, and OTel attribute writes that can prevent `span.end()`. Nothing
here excuses any of those; AR-4's recovery rounds fixing them are the loop working.

The
five-round cap stays — it is what caught all three of these — but the response to a cap is
**re-scope and escalate to the controller**, never grind another round on an undecidable
problem.

Rejected alternatives:

- **Keep hardening the bespoke analyzers until they are "right."** They cannot be, in the
  general case, and the review loop demonstrably does not terminate; they are also the
  wrong layer (the sandbox, the credential scope, and approval gates are the real limits).
- **Rip out AR-1's 182 tests now.** They pass and block nothing, so removing them is
  churn for its own sake. Leave them; do not build another like them; when AR-1 is next
  touched, prefer the Semgrep-rule-plus-credential-scoping equivalent recorded above.

## Consequences

- **WS-10 unblocks** by swapping the hand parser for a streaming HTML rewriter — a
  well-scoped change that also unblocks WS-2 (Modal images depend on the baked proxy).
- **VF-14 collapses** from nine bespoke detectors to a thin layer over `knip` / ESLint /
  `tsc` / `jscpd` / Semgrep, with the two semantic-judgment checks (component similarity,
  "missing loading/empty/error states") demoted to Minor signals or deferred to OPS-13.
- **VF-11** (exploratory browser agent) stays as written but is explicitly best-effort:
  deterministic Playwright (VF-7/VF-8) is the M3 gate; the agent's findings are
  evidence-schema-gated and never a merge blocker, and agent flakiness is not a P1 finding.
- **AR-11/AR-16/AR-20** use `graphlib` for the DAG and keep their interview/diff scorers as
  bounded, Minor-severity heuristics, not completeness gates.
- **AGENTS.md** gains the rubric rule so every future review inherits it.
- Net effect on speed: the tasks that were "going on forever" were the completeness-chasers.
  Right-sizing them is where the time comes back — **not** from reviewing less. The review
  gates that caught the device-flow token leak, the proxy rate-limit collapse, and the
  never-green Desktop workflow stay exactly as strict.

**Exit condition.** If a real incident shows a structural control is insufficient (not that
a heuristic was incomplete — that is expected), revisit the specific control. The signal to
watch is a *structural* gap; heuristic bypasses are noise by design.
