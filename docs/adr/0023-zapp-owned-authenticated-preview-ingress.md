# 0023 — zapp-owned authenticated preview ingress

Status: accepted (controller-delegated decision, 2026-08-09)
Supersedes: ADR-0003's WS-12 provider-token correction
Affects: plans 03, 08, and 09; `packages/contracts`; `packages/db`; `packages/api-client`; `services/control-api`; `services/sandbox-service`; `apps/web`
References: PRD §18.11, §18.13, §21.3, §26A.1; ADR-0022

## Context

WS-12 binds authenticated, expiring, revocable preview access to Modal connect tokens.
The locked runtime uses Modal V2 VM sandboxes. Pinned `modal@0.9.0` calls
`#ensureV1("createConnectToken")`, so that operation deterministically rejects for every
zapp workspace. Its token API also accepts only `userMetadata` and `port`; it exposes no
expiry or revocation primitive. Downgrading the already-accepted V2 runtime would discard
the image, tag, volume, readiness, and containment boundary proven by WS-2. Upgrading the
SDK without a proven replacement API would only exchange a known blocker for an unbound
vendor dependency.

Modal V2 does support encrypted port tunnels. zapp already provisions and consumes an
encrypted agent tunnel server-side. The load-bearing requirement is authenticated,
tenant-safe, expiring, revocable preview access—not a provider-branded token or a provider
URL in a client.

## Decision

zapp owns the preview access boundary. Modal remains the sandbox and encrypted-transport
provider, but no Modal tunnel URL or credential reaches a browser, desktop client, API
response, event, audit record, or durable share row.

### Internal preview transport

`sandbox-service` provisions encrypted ports `8877` and `8080`. A service-authenticated
internal preview route resolves the workspace by `(organizationId, projectId,
workspaceId)`, attaches to its provider sandbox, resolves the encrypted `8080` tunnel,
and forwards HTTP and WebSocket traffic. The route never returns tunnel metadata. Unknown,
terminated, or cross-tenant workspaces return the existing stable 404 boundary.
It removes hop-by-hop headers and every zapp service/session/tenant credential before the
request enters the sandbox; only application headers and the explicitly reconstructed
application cookie header cross the tunnel. Client input can never select a tunnel host or
port. Downstream aborts cancel the provider stream instead of buffering or orphaning it.

### Durable public shares and sessions

`control-api` owns durable `preview_shares` rows under an organization/project/workspace:
`id`, `tokenHash`, `policy`, `expiresAt`, `revokedAt`, creator, and timestamps. It exposes
versioned `/v1` create, list, revoke, session-exchange, and proxy routes and regenerates the
public SDK in the same task.

Share URLs use the web bootstrap
`{APP_BASE_URL}/preview/{organizationId}/{shareLocator}#token={opaqueBearer}`. The
organization ID and share locator are non-secret; the fragment is never sent in an HTTP
request. The authenticated application itself gets an isolated zapp origin at
`https://{organizationLocator}-{shareLocator}.PREVIEW_BASE_DOMAIN` (the configurable
development equivalent uses `*.localhost`). The lowercase ULID locator reconstructs the
organization scope before any row lookup. A per-share application origin is required
because generated apps use root-relative URLs, cookies, service workers, and WebSockets. A
path-prefixed proxy would route those requests into control-api and would let two previews
collide in one browser origin.
Create is keyed: the share ID is derived from the tenant-scoped operation key and the bearer
is deterministically derived with HMAC-SHA256 from that ID plus a versioned
`PREVIEW_SHARE_SIGNING_KEY`. The durable row stores only the Argon2id hash and key version,
so a retry returns the identical URL without persisting plaintext and concurrent creates
cannot mint two shares.
The web bootstrap posts the fragment bearer in a redacted/no-store body to the session
exchange. The repository lookup is always scoped by the locator organization before the
Argon2id token-hash comparison. `policy: "org"` additionally requires an active session in
that organization. `policy: "anyone_with_link"` requires the bearer but no organization
session. Missing, mismatched, expired, and revoked records return the same 404/401 policy
envelope without tenant disclosure.

A successful exchange is two body-only, keyed steps because the existing organization
session cookie and the preview cookie are intentionally host-only. First, the web bootstrap
posts the share bearer to control-api's
`POST /v1/organizations/:organizationId/preview-shares/:shareId/sessions`; control-api can
therefore verify the existing org session for `policy: "org"`. It derives a short-lived,
single-share bootstrap grant with a domain-separated HMAC and stores only its hash in Redis.
The no-store response contains the zapp preview origin and the one-time grant, never the
share bearer or a provider value. Second, the bootstrap posts that grant to
`POST /v1/preview/session` on the configured share origin with an exact `APP_BASE_URL` Origin
and `credentials: include`. Redemption derives a stable session ID and secret, stores only
the secret hash in Redis with `(organizationId, shareId)` and a TTL no later than the share
expiry, and sets the secret in a short-lived Secure, HttpOnly, SameSite=Lax host-only cookie.
The grant remains replayable only for its bounded bootstrap TTL so a lost response can
reissue the same cookie, then expires. Both steps are manually keyed rather than cached by
the generic response idempotency plugin, avoiding plaintext response persistence. The
bootstrap removes the fragment and grant from memory before loading the preview origin.
Every later HTTP request and WebSocket handshake on that origin resolves the tenant-scoped
Redis session and rechecks the organization-scoped share row.
Revocation is idempotent, deletes matching sessions, publishes through the existing Redis
fanout, and closes matching live HTTP streams and WebSockets on every replica. A five-second
timer on every live connection rechecks the row, bounding a missed notification; revoked
access therefore fails within ten seconds without relying on process-local state. The
exchange body and cookie are redacted from request logs, responses are `no-store`, and the
fragment bearer never appears in a server URL.

### API and client contract

`PreviewHandle` carries a zapp URL and expiry, not a Modal URL or provider token. Management
uses strict `POST /v1/workspaces/:workspaceId/preview/shares`,
`GET /v1/projects/:projectId/preview/shares`, and
`DELETE /v1/workspaces/:workspaceId/preview/shares/:shareId` routes; the wildcard preview
origin serves only the versioned session exchange plus the authenticated application data
plane. Both `APP_BASE_URL` and `PREVIEW_BASE_DOMAIN` are configuration, never inferred from
an untrusted Origin or Host header.
The stale
provider-facing `CloudSandboxProvider.createPreview()` method is removed; preview transport
resolution is an internal sandbox-service capability, while public handle/share creation is
owned by control-api. Share create returns `{ id, url, expiresAt, policy }`; list never
returns a bearer or token hash;
delete is keyed/idempotent. The web and desktop preview surfaces consume only these zapp
URLs. The existing preview proxy on port 8080 remains responsible for application routing,
capture events, and HMR/WebSocket forwarding.

## Rejected alternatives

- **Modal V1 sandboxes:** incompatible with the accepted V2 runtime and still lacks the
  required expiry/revoke API in the pinned SDK.
- **SDK upgrade as the architecture:** no verified V2 token-lifecycle contract; vendor
  churn must not define zapp's user authorization boundary.
- **Raw encrypted tunnel URLs in clients:** bypasses zapp authorization and durable
  revocation and violates the existing “never raw public tunnels” requirement.
- **Process-local share/session registries:** fail across replicas and restarts.

## Consequences

- WS-12 expands across the public API boundary: contracts/DB/control-api/generated SDK,
  sandbox-service internal transport, environment configuration, and the web bootstrap ship
  together. Production deployment must route the configured wildcard preview domain to
  control-api; local acceptance uses the matching `*.localhost` host rule.
- The control plane becomes the authenticated preview ingress for P0. This is an explicit
  bounded data-plane cost; streaming remains pass-through and can later move behind the
  same contract without changing clients.
- ADR-0003's proposed provider `previewToken` and `revokePreview(previewToken)` amendment
  is not implemented. Revocation applies to the zapp share/session at the structural
  authorization boundary.
- WS-2 continues to prove encrypted tunnel capability, but no longer claims V2 connect
  tokens. WEB-7 and MAC-8 consume zapp preview URLs.
