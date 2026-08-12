# M2-M6 completion design

## Goal

Finish the remaining P0 product tasks through the same public contracts used by every client,
then run the milestone evidence gates without converting missing credentials or beta partners
into false successes.

## Architecture

The control API remains the only browser/desktop product boundary. It authorizes tenant and
role access, then calls service-owned ports:

- orchestrator-worker owns retry, skip, interactive cards, and approval durability;
- sandbox-service owns workspace file access and direct-edit execution;
- git-service owns commit comparison, approved template seeding, and scoped Git credentials;
- verification owns test/evidence metadata and artifact delivery;
- release-service owns deployment classification, stages, health, synthetics, annotations,
  rollback compatibility, and custom domains;
- notification projections remain server-side and are delivered through an authenticated,
  cursor-resumable public stream.

The generated SDK is regenerated after each serialized public-contract task. Web and desktop
consume only that SDK. A pure shared builder event reducer and shared presentation components
live in `packages/ui`; platform wrappers own browser- or Electron-specific behavior.

## Durable state

- Plan phases gain rollout-compatible `optional: false` metadata.
- Control requests carry stable operation ids through Temporal signal handling.
- Deployment events are keyed by deployment id and support replay from a sequence cursor.
- Synthetic results and release annotations are append-only history, not a last-status field.
- Desktop promotion is a local durable state machine keyed by repository fingerprint.
- Notification cursors and preferences are durable per user/device.

## User-visible behavior

Mission Control shows only actions currently allowed by the server. Interview, specification,
plan, redirect, budget, migration, and deploy decisions render from typed cards. Code, logs,
tests, evidence, settings, release, deploy, health, and desktop surfaces reconcile optimistic
state against authoritative events or reads. No screen infers success from prose.

## Failure behavior

- Stale eligibility returns a typed conflict and the latest state.
- Direct edits reject stale compare tokens and leave no partial commit.
- Deployment stream reconnects from the last durable sequence.
- Git credential expiry prompts a fresh lease; credentials are not refreshed in place.
- Update, notification, Grafana, and provider outages never fabricate success.
- M6 validators fail closed when evidence, measurements, credentials, or agency participation
  is absent.

## Verification

Each prerequisite and product task follows RED-GREEN, package lint/typecheck/build, generated
contract determinism, at most two review rounds, one commit, tracker/log bookkeeping, and no
provider call before its final acceptance gate. Milestone exit checks run after their owning
tasks are complete.
