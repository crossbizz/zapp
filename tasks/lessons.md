
## 2026-08-04 — Verify push gates against committed state, not the working tree

**What happened:** A migration adding TRUNCATE guards landed on main. Its required
test-harness repair existed only as uncommitted work in a subagent's tree. I ran the
integration suite locally, saw green, and released the push hold — CI went red on the
3 tests the guards broke.

**Why:** The local run used the dirty working tree, which contained the fix. The
pushed commit did not.

**Rule:** When a hold exists because commit A needs commit B, verify from a clean
checkout of HEAD (`git worktree add` / `git archive`), never the working tree. A green
local run only proves the tree is green, not that main is.

**Related:** turbo `lint` also needed `dependsOn: ["^build"]` — type-aware lint rules
resolve workspace imports through `dist/`, so a cold CI checkout reported `no-unsafe-*`
errors that never reproduce locally where `dist/` survives from earlier builds.
