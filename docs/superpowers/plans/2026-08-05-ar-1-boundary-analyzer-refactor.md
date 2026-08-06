# AR-1 Provider-Boundary Evaluator Refactor Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every implementation step and `superpowers:verification-before-completion` before committing.

**Goal:** Make the model-provider boundary gate fail closed without false positives by replacing the split mutation-receiver analysis with one source-ordered abstract evaluator.

**Architecture:** The analyzer will have one runtime evaluator for expression results and state transitions. It returns an `AbstractValue` plus updated bindings, where array identity knowledge is exactly `known(Set)` or `unknown`; unsupported syntax can never silently become a known empty set. The same evaluator executes assignment, branching, logical reachability, calls, methods, accessors, and function bodies. Array mutation provenance consumes only that evaluator's receiver result. Existing provider-kind/import/call inventories remain the static facts that seed values, but they are no longer a second authority for receiver result semantics.

**Tech stack:** Node.js 22, TypeScript compiler AST, `node:test`, existing model-provider boundary fixture harness.

---

## Task 1: Freeze the adversarial semantic contract

**Files:**

- Modify: `scripts/model-provider-boundary.test.mjs`
- Create: `scripts/model-provider-boundary-fixtures/loader-mutation-evaluator-unsafe/**`
- Create: `scripts/model-provider-boundary-fixtures/loader-mutation-evaluator-control/**`
- Create: `scripts/model-provider-boundary-fixtures/loader-mutation-evaluator-unknown/**`

### Step 1: Add paired unsafe/control fixtures

Add load-bearing fixtures for:

- opaque call result;
- plain, array-destructuring, object-destructuring, `&&=`, `||=`, and `??=` assignment results;
- conditional plus `&&`, `||`, and `??` receiver results;
- callee and method side effects that reattach a detached alias;
- function, method, and accessor return identities;
- a known-array truthiness control such as `(slots && [])`;
- unconditional-return and branch-return reachability controls;
- detached aliases, earlier snapshots, and nested reassignment controls;
- an unresolved receiver that must emit `unresolved-loader`.

Every unsafe fixture must produce a new-provider violation. Every matched control must be clean.

### Step 2: Run RED and capture the exact mismatch set

Run:

```bash
node --test --test-name-pattern='source-ordered mutation evaluator' scripts/model-provider-boundary.test.mjs
```

Expected: the new test fails on the seven independently reproduced classes from the review. Existing focused tests must remain green.

### Step 3: Commit fixtures only if a long refactor needs a checkpoint

Do not report the task done at this checkpoint. If committed, use:

```text
test(architecture): pin provider-boundary evaluator semantics
```

---

## Task 2: Define one state and one result contract

**Files:**

- Modify: `scripts/model-provider-boundary/analyzer.mjs`
- Modify: `scripts/model-provider-boundary.test.mjs`

### Step 1: Add resolver-level tests

Expose a test-only diagnostic only if fixture assertions cannot distinguish the state. Assert:

- a fresh array literal returns `known({literal})`, truthy, and non-nullish;
- a proven non-array primitive returns `known(empty)`;
- an opaque/unsupported result returns `unknown`;
- merging any reachable unknown alternative returns `unknown`;
- unreachable alternatives do not participate in the merge.

Run the focused test and confirm RED before implementation.

### Step 2: Normalize `AbstractValue`

Keep the existing callable/provider facts, but make these invariants unconditional:

- every value has `arrayIdentities`;
- `known(empty)` is constructed only when the result is proven non-array;
- `known(non-empty)` implies definitely truthy and non-nullish;
- `unknown` means the result may be an array and must fail closed when a tracked loader is inserted;
- branch merge uses reachable alternatives only.

Delete any fallback that derives known-empty merely because an AST form is unsupported or the checker does not prove an array.

### Step 3: Run the resolver tests GREEN

Run the focused resolver test twice. Mutation-test the unknown constructor in memory so the unresolved fixture stops detecting a violation and the mutation probe exits non-zero.

---

## Task 3: Replace receiver evaluation with the source-ordered evaluator

**Files:**

- Modify: `scripts/model-provider-boundary/analyzer.mjs`
- Modify: `scripts/model-provider-boundary.test.mjs`

### Step 1: Implement evaluator state

Introduce one state object containing:

- symbol-to-`AbstractValue` bindings;
- data-only container facts;
- call stack / recursion guard;
- `this` value;
- normal/return completion state.

Cloning and merging state must preserve exact known identities and promote incompatible/unsupported alternatives to `unknown`.

### Step 2: Implement expression evaluation in JavaScript order

The evaluator must own, without a receiver-specific fallback:

- identifiers and literals;
- property/element reads, including computed keys and getter invocation;
- arrays/objects/spreads;
- comma, conditional, `&&`, `||`, and `??`;
- plain and destructuring assignment (assignment returns the RHS value);
- logical assignment (read LHS once, evaluate RHS only on reachable branches, write target, return selected value);
- calls, methods, constructors, and accessors (callee/owner then arguments in order; apply body effects; return analyzed result);
- `await` and transparent wrapper expressions;
- unsupported effectful syntax by conservative state invalidation plus an `unknown` result.

Static `callableValue` data may seed a leaf value, but may not independently decide receiver identities, branch reachability, or call side effects.

### Step 3: Implement statement and function completion

Use the same evaluator for prelude statements and invoked function bodies:

- sequential blocks stop after an unconditional return;
- `if`/conditional paths evaluate only reachable branches and merge only continuing/returning paths of the same completion kind;
- variable declarations and assignment patterns update bindings;
- calls and expression statements retain their side effects;
- unsupported statements conservatively invalidate reassignable bindings rather than fabricate known-empty identities.

### Step 4: Remove duplicate semantic authority

Replace `straightLineArrayMutationValue()` / `pointExpressionValue()` with the unified evaluator entry point. `addArrayMutationProvenance()` must consume that one receiver result and must not fall back to `callableValue()` or `mutationTargetSymbols()`.

Any helper used by member-refinement logic, including the old `straightLineArrayMutationTargets()`, must delegate to the same evaluator result or be deleted.

### Step 5: Run focused GREEN

Run:

```bash
node --test --test-name-pattern='source-ordered mutation evaluator|carries array identities|detached receiver identities|identity is unknown' scripts/model-provider-boundary.test.mjs
```

Expected: all paired unsafe/control/unknown tests pass with zero skips.

---

## Task 4: Prove the security gate and production baseline

**Files:**

- Modify only if mechanically required: `config/model-provider-boundary-baseline.json`
- Modify only if its text no longer matches implementation: `docs/adr/0005-desktop-provider-migration-window.md`
- Modify: `docs/plans/04-agent-runtime.md`
- Modify: `tasks/todo.md`

### Step 1: Run the full analyzer suite

```bash
node --test scripts/model-provider-boundary.test.mjs
```

Expected: all tests pass, zero skipped/todo.

### Step 2: Run production boundary validation

```bash
node scripts/check-model-provider-boundary.mjs
```

Expected: exactly the nine inherited ADR-0005 desktop paths, anchored to `df81175`; no inventory growth. Do not update the baseline to absorb a new path or new provider use.

### Step 3: Run package and repository checks

Use Node 22.23.1 and run:

```bash
pnpm --filter @zapp/model-gateway test
pnpm --filter @zapp/model-gateway lint
pnpm --filter @zapp/model-gateway typecheck
pnpm --filter @zapp/model-gateway build
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Run the analyzer's adversarial matrix at least 25 consecutive times to catch state/cache nondeterminism.

### Step 4: Independent review

Require a fresh reviewer to verify:

- no unsupported result becomes known-empty;
- receiver evaluation has one semantic authority;
- calls/methods/accessors preserve source order and effects;
- unreachable paths do not contaminate results;
- detached/snapshot controls remain precise;
- ADR-0005's exact production inventory remains unchanged.

Any Critical/Important finding keeps AR-1 unchecked.

### Step 5: Record completion only after approval

If and only if every command and review is green:

- check every AR-1 step in `docs/plans/04-agent-runtime.md`;
- check AR-1 in `tasks/todo.md`;
- append an execution-log line describing the accepted ADR-0005 exception and unified fail-closed evaluator;
- commit with the binding task message:

```text
feat(model-gateway): provider-neutral streaming completion API
```

If the service implementation commit already uses that exact message, keep the analyzer remediation as a separate preceding fix commit and use the binding message only for the final tracker/log commit.
