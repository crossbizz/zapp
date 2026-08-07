# ADR-0018: Internal Git stays Forgejo; GitHub remains an optional peer remote

- Status: Accepted
- Date: 2026-08-07
- Owners: controller (product-owner delegated decision)
- Approval: the product owner asked "we don't need Forgejo, the repository is already initialized with GitHub, just use that", then delegated the call: "you make the call and decision for Forgejo", 2026-08-07
- Affects: `services/git-service` (GIT-1/2/3/4), plan 06 INT-1..4, PRD §19.1, master §2 decision 1
- References: PRD §19.1, §19.2, §19.3, §6.1, §10.0; master plan §2 decision 1; ADR-0001

## Context

The question arose from a real ambiguity worth stating plainly, because it is the most
likely thing for a future reader to re-litigate.

**Forgejo has never hosted the zapp repo.** `github.com/crossbizz/zapp` has, from the first
commit. Forgejo hosts the repositories of the **applications zapp builds for users** — one
private repo per customer project, created at project creation (CP-6), cloned into the
Modal workspace (WS-5), and committed to on every agent task.

So "the repository is already on GitHub, just use that" is true of *our* repo and does not
remove the need Forgejo serves. Adopting GitHub for customer projects instead is a distinct
and much larger product change, which is the decision this ADR settles.

The constraint that governs it is PRD §19.1, verbatim: *"zapp.build must work without
requiring a user GitHub account."* That is not an implementation note — it is a product
promise, and it is load-bearing for the two things the PRD treats as the core of the
product:

- **The activation flow** (PRD §10.0): a non-technical user describes an app and gets a
  live preview. Requiring a GitHub signup, an OAuth grant, and a repo-creation scope before
  the first build inserts the exact friction the flow exists to remove.
- **The primary persona** (PRD §6.1, agencies): the code being hosted is their *clients'*.
  "Every one of your clients needs a GitHub account, and we need permission to create
  repositories in it" is a materially harder sell than "your code lives in zapp, and you
  can connect GitHub whenever you want."

GitHub already has its designed place in the architecture: §19.2 and §19.3 make it a
**peer remote** — import, export, push-or-PR sync at commit boundaries — via plan 06's
INT-1..4, which are unbuilt. Nothing about keeping Forgejo prevents a user from working
entirely through GitHub if they choose.

Current state: GIT-1/2/3 shipped, independently reviewed, and CI-gated. Forgejo has neither
repository-scoped tokens nor expiring tokens natively, so both were built (restricted
ephemeral collaborator + sweep), and cross-repo denial is enforced by a dedicated
`git isolation (repository-scoped tokens)` job that proves a real `git clone` of another
tenant's repo is refused. GIT-4 (nightly bundle backups + a live recovery gate) is done.

## Decision

**Forgejo remains the internal Git provider for customer projects. GitHub remains an
optional peer remote.** No code is removed.

The `GitProvider` interface stays provider-neutral per PRD §19.1 ("the final choice is an
engineering decision, but the product contract is provider-neutral"), so the *hosting*
decision remains reversible without touching callers — but the *product* decision, that a
user never needs a GitHub account to build and run an application on zapp, is affirmed and
should be treated as settled.

Rejected alternatives:

- **GitHub as the product's Git backend.** Contradicts PRD §19.1 outright; makes a GitHub
  account a precondition for the activation flow; requires a GitHub App with
  repo-creation scope on every customer or a zapp-owned org holding all customer code;
  couples the core build loop to GitHub's availability and per-installation API rate limits;
  and deletes ~4k lines of reviewed, CI-gated work along with the only test proving customer
  repos are isolated from one another. It would also force a PRD amendment rather than
  following from one.
- **Drop Forgejo from the local dev stack only** (keep the service, make the container
  opt-in). Considered because the original prompt may have been about docker-compose noise.
  Rejected as a false economy: `scripts/dev-up.sh` already brings it up idempotently, and
  the git-service integration suite — including the cross-repo denial gate — needs a live
  instance. Making it opt-in would make the security suite skip by default, which is exactly
  the silent-skip failure mode already recorded in `tasks/lessons.md`.
- **A managed Git host instead of self-operated Forgejo.** This is the *right* answer to the
  real cost below, and it remains available at any time behind `GitProvider` — but it is not
  what was asked, changes no product promise, and would be premature to execute now while
  M1 is unfinished.

## Consequences

**Accepted cost, stated honestly.** Forgejo is a stateful service we operate: a volume, an
upgrade path, security patches, and a restore drill. That is genuine ops burden for a small
team, and the instinct behind the original question was sound. It is mitigated, not
eliminated: GIT-4 ships nightly `git bundle` backups to R2 with a live recovery gate in CI,
`prevent_destroy` is set on the Fly volume, and the terraform + bootstrap path is committed.

**What stays true.** Users can build, run, and deploy without ever touching GitHub.
Customer repos are isolated by construction and proven by a CI gate on every push. Plan 06's
INT-1..4 remain the path for users who *want* GitHub, and nothing here blocks or delays them.

**Exit condition.** If operating Forgejo becomes the binding constraint, swap the
`GitProvider` implementation to a managed Git host — a service-level change behind an
interface that already exists, requiring no PRD amendment and no change to the promise that
a user needs no GitHub account. Revisit if that operational cost materializes, **not**
because our own repository happens to live on GitHub.
