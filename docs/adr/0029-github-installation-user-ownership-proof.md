# ADR-0029: Prove GitHub installation ownership with an ephemeral user token

- Status: Accepted
- Date: 2026-08-10
- Owners: control plane / integrations / security
- Approval: delegated self-approval for INT-1 review-round security corrections, 2026-08-10
- Affects: Plan 06 INT-1, GitHub App credentials and provider adapter
- References: ADR-0028; GitHub setup URL and GitHub App user-token documentation

## Context

GitHub redirects an App setup flow with a caller-visible `installation_id` and explicitly warns
that the value can be spoofed. App JWT authentication can retrieve any installation belonging to
the App, so an App-wide `GET /app/installations/{id}` does not prove that the callback user can
access the requested installation.

## Decision

INT-1 must exchange the actor-bound callback code with the GitHub App client ID and client secret.
The provider adapter uses the resulting ephemeral user access token to paginate
`GET /user/installations` and accepts the requested installation only when its ID appears in that
user-scoped response. The callback code, user token, refresh token, and client secret remain inside
the provider call: they are never persisted, logged, returned, audited, or used for discovery.

Only after this proof may the control plane create the organization-level connection. A partial
unique expression index on organization, provider, and GitHub installation ID makes concurrent
valid callbacks converge on one durable connection. Repository and branch discovery continue to
resolve that tenant-scoped connection before any installation-token exchange or provider read.

## Consequences

The deployed service additionally requires `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_CLIENT_SECRET`. The GitHub App must enable user authorization during installation so
the setup callback contains a one-time code. Live verification also needs a fresh callback code.
Spoofed installation IDs fail without creating a connection or enabling discovery, while retries
for an already-associated valid installation remain idempotent under concurrency.
