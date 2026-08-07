# ADR-0010: Model provider integration layer

- Status: Accepted
- Date: 2026-08-06
- Owners: agent runtime
- Approval: controller decision under the user's delegated decision authority, 2026-08-06
- Affects: `services/model-gateway` (AR-1, AR-2, **AR-3**), `config/models.json`, plan 04, plan 10 OPS-1, plan 10 OPS-16 vendor register
- References: PRD §15.4, §30.1, §35, §37.6; master §2 decision 6, Global Constraints 2/16/20; ADR-0009

## Context

PRD §35 lists the agent SDK as `Vercel AI SDK **or equivalent** provider-neutral
TypeScript layer`. The master plan and plan 04 propagated the named option without an
options analysis. Other rows of that same table did get scrutiny — Sentry was replaced by
Grafana Cloud, and the product owner replaced WorkOS with Stytch — so the table was never
treated as binding. This row simply was not examined. The product owner surfaced the gap
by asking why the Vercel AI SDK was chosen and then why not OpenRouter; neither question
had a recorded answer. This ADR supplies one and records the criteria, so the next reader
inherits a decision rather than an inheritance.

What exists today (AR-1 and AR-2 are done):

- `services/model-gateway` is the only permitted model call site (Global Constraint 2),
  enforced by a boundary analyzer whose remediation was AR-1's blocker.
- Four adapters behind one `ProviderAdapter` interface (`provider`, `stream`):
  `anthropic`, `openai`, `google`, `compatible`.
- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` pinned to exact versions.
- `config/models.json` binds four roles to `<provider>/<model>` references with
  cross-vendor fallbacks. Per master §2 decision 6, **Anthropic is the primary for all
  four roles**; OpenAI and Google appear only as fallbacks.
- `ModelReferenceSchema` splits on the *first* `/`, so a three-segment reference such as
  `compatible/anthropic/claude-sonnet-4` resolves to the `compatible` adapter carrying a
  vendor-qualified model id.
- `compatible` is configured by `baseUrlEnv` + `apiKeyEnv` + `name` — an OpenAI-compatible
  endpoint is reachable by configuration alone, with no code change.
- The usage event schema already carries an optional `cachedInputTokens`.

Four forces make the transport choice consequential rather than cosmetic:

1. **PRD §30.1 requires metering "model cached tokens where provider reports them."**
   That is a product requirement, not an optimization. `cachedInputTokens` has a field but
   no producer: **AR-3 is unbuilt**, and it is the task that must populate it.
2. **The context shape is maximally cacheable.** AR-7 assembles approved spec, current
   plan, decision log, architecture summary, file index and recent changes, then re-sends
   that prefix every turn. On Anthropic's published multiplier structure — cache write
   ≈1.25× base input, cache read ≈0.1× — a 20-turn run with a 30k-token stable prefix and
   2k of per-turn delta costs ~640k input-token-equivalents uncached versus ~135k cached,
   roughly a 4.7× reduction on the dominant cost line. Actual rates live in
   `config/pricing.json` per Global Constraint 20; the order of magnitude is the point.
3. **PRD §37.6 targets model + Modal below 25% of collected revenue**, and the business
   resells inference through credits. Anything that multiplies or forfeits input-token
   cost lands directly on that ratio.
4. **Reversal gets more expensive with every dependent task.** AR-4/AR-5/AR-6 are blocked
   and AR-7/AR-8 unbuilt, all of them downstream of the gateway.

The unresolved question is therefore narrow and testable: *can the chosen transport both
set cache breakpoints and report cache reads?* Nothing in the repo answers it, because the
task that would (AR-3) has not run.

ADR-0009 decides *which* model a run uses — the run-intent contract, organization model
policy, and the `model` field. This ADR sits beneath it and decides *how the gateway
reaches a provider once that model is chosen*. The two do not overlap.

## Decision

**The architectural commitment is the adapter boundary, not the SDK.** `ProviderAdapter`
and the `CompleteRequest` contract are what the platform depends on; which client library
sits inside a given adapter is an implementation detail, chosen per adapter and reversible
one adapter at a time. Everything below follows from that.

**1. The Vercel AI SDK remains the default transport for all four adapters.** No
preemptive migration. It satisfies PRD §15.4's provider set, its tool-schema conversion is
per-provider and already confined to adapters, and it is shipped and pinned. Swapping it
today would trade a known quantity for speculation.

**2. AR-3 must prove prompt caching, and the outcome is pre-authorized.** AR-3 ships a
test against the Anthropic adapter that:

- sets a cache breakpoint on a stable prefix,
- issues two completions and observes a cache **write** on the first and a cache **read**
  on the second,
- asserts `cachedInputTokens` is non-zero on the second and flows through to the usage
  event OPS-1 records.

If that behaviour cannot be expressed through the AI SDK, **the Anthropic adapter alone
moves to `@anthropic-ai/sdk` behind the unchanged `ProviderAdapter` interface, without a
new ADR.** The other three adapters stay. Deciding this in advance is the point: it stops
a predictable finding from becoming a re-litigation at the moment it is most expensive.
Both halves must pass — the ability to *write* breakpoints creates the saving, the ability
to *read* cache counters satisfies §30.1.

**3. OpenRouter is permitted only behind the `compatible` adapter, for three named uses:**
benchmarking candidate models at the master §2 decision-6 gate in M3; reaching models we
do not integrate directly; and serving as an *independent* break-glass fallback route.

**It must never be a role's primary, and never the transport for a vendor the gateway
already reaches directly.** As an additional, failure-independent route it strictly
increases resilience; as a replacement for direct routes it removes resilience while
appearing to add reach. Three reasons it loses the primary slot:

- *Data path.* Every completion carries customer source code, and for the primary persona
  (PRD §6.1, agencies) that is their clients' code. A proxy is an additional processor on
  that path, and may fan out further upstream. This is a governance cost, not a security
  defect — it is a vendor-register and DPA entry (master §6, plan 10 OPS-16) and a
  due-diligence question in agency deals. We pay it where it buys reach we cannot get
  otherwise, not on the path we already have direct.
- *Margin.* A percentage fee on inference sits on the cost side of the §37.6 ratio and
  compounds with usage. Paying an intermediary on COGS is a pricing decision, and the
  business already resells the underlying tokens.
- *Resilience topology.* AR-2 fails a role over across three vendors precisely so one
  vendor's outage does not stop builds. Routing those three through one proxy gives them a
  shared control plane and a correlated failure mode — re-concentrating the single point
  of failure the fallback chain exists to survive. OpenRouter's own upstream failover
  protects against upstream failure, not against OpenRouter.

**4. A role's primary and fallbacks may not all resolve through one transport.**
`config/models.json` validation enforces it, so the independence AR-2 assumes cannot be
silently configured away.

Rejected alternatives:

- **OpenRouter as the primary transport.** Genuinely attractive: it delivers PRD §15.4's
  provider set, routing and fallback as a service, one key, one bill, and a nearly free
  BYOK story later. It loses on the three grounds above — each of which is structural
  rather than a matter of implementation quality.
- **Direct provider SDKs everywhere, immediately.** Buys full feature access and removes
  upstream-cadence risk, but costs three tool-schema converters, three streaming shapes
  and three error taxonomies that we then own — reintroducing, inside our code, the
  normalization the adapter boundary was drawn to contain. Warranted for one adapter where
  a specific capability pays for it; not as a default.
- **LiteLLM.** A self-hosted proxy keeps the data path in-house, but it is a Python
  service in a monorepo whose Global Constraint 16 fixes Node 22 + TypeScript, and its
  headline features — unified routing, budgets, key management, telemetry — are precisely
  what `services/model-gateway` already is, specified against our own contracts in AR-2 and
  AR-3. It adds a second language runtime and another service to deploy, monitor and keep
  in the secret path, in exchange for capabilities we have built.
- **Cloud provider gateways (Bedrock, Vertex).** Neither covers the required provider set
  on its own, so direct paths would remain regardless; both add cloud-account coupling.
  Relevant later as an enterprise deployment option, not as the P0 integration layer.

## Consequences

**Easier.** The transport question is now answerable per adapter with a test rather than by
argument. Adding a model that exists on an OpenAI-compatible endpoint stays a configuration
change. The M3 benchmark can evaluate candidates without an adapter per candidate.

**Harder.** Mixing transports — the outcome if the AR-3 caching test fails — means two
error taxonomies and two usage shapes normalizing into one contract. That cost is accepted
knowingly, confined to one adapter, and is why the swap is conditional rather than default.

**Work this creates:**

- **AR-3** gains the caching acceptance test above as a blocking criterion, and must record
  in plan 04's execution log which branch of decision 2 was taken and on what evidence.
- **AR-2** gains the transport-independence validation from decision 4, with a test that a
  role whose primary and fallbacks collapse to one transport fails configuration load.
- A test pinning that `compatible/<vendor>/<model>` resolves to the `compatible` adapter
  with the vendor-qualified model id preserved. The first-separator split implies this;
  nothing currently asserts it, and OpenRouter's ids depend on it.
- Enabling OpenRouter adds a vendor-register and DPA entry (plan 10 OPS-16) and, because
  customer code transits it, a subprocessor disclosure. Adoption is a controller decision
  at that point, not automatic.
- `compatible` is a **single** provider slot in the schema. Pointing it at OpenRouter
  spends the only generic OpenAI-compatible route. If a second such endpoint is ever
  needed, generalize `providers.compatible` into a keyed map — additive, but not free.

**If this is reversed**, the blast radius is one service: `CompleteRequest` and
`ProviderAdapter` are ours, so callers are unaffected. That containment is the reason the
decision is affordable to revisit, and the reason the SDK was never the load-bearing part.

**Exit conditions.** Revisit if any of: the AR-3 caching test fails on the AI SDK (triggers
decision 2's pre-authorized swap, no new ADR); the AI SDK ships a major that breaks the
adapter surface (pinned versions make this a scheduled migration, not an incident); the M3
decision-6 benchmark moves the default primaries off Anthropic, which changes where caching
pays; or BYOK is pulled forward from post-P0, which materially strengthens the OpenRouter
case and warrants a superseding ADR rather than an amendment.
