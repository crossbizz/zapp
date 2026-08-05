/** Generated from the live public OpenAPI document. Do not edit. */
export const PUBLIC_API_OPERATIONS = {
  "/v1/auth/callback": [
    "get"
  ],
  "/v1/auth/device": [
    "get"
  ],
  "/v1/auth/device/approve": [
    "post"
  ],
  "/v1/auth/device/deny": [
    "post"
  ],
  "/v1/auth/device/token": [
    "post"
  ],
  "/v1/auth/login": [
    "get"
  ],
  "/v1/auth/logout": [
    "post"
  ],
  "/v1/auth/refresh": [
    "post"
  ],
  "/v1/integrations/github/install": [
    "post"
  ],
  "/v1/integrations/neon/connect": [
    "post"
  ],
  "/v1/integrations/stripe/connect": [
    "post"
  ],
  "/v1/integrations/supabase/connect": [
    "post"
  ],
  "/v1/invites/{token}/accept": [
    "post"
  ],
  "/v1/me": [
    "get"
  ],
  "/v1/organizations": [
    "get",
    "post"
  ],
  "/v1/organizations/{orgId}": [
    "patch"
  ],
  "/v1/organizations/{orgId}/invites": [
    "post"
  ],
  "/v1/organizations/{orgId}/members/{userId}": [
    "delete",
    "patch"
  ],
  "/v1/projects": [
    "get",
    "post"
  ],
  "/v1/projects/{projectId}": [
    "get",
    "patch"
  ],
  "/v1/projects/{projectId}/contract": [
    "get"
  ],
  "/v1/projects/{projectId}/releases": [
    "post"
  ],
  "/v1/projects/{projectId}/runs": [
    "get",
    "post"
  ],
  "/v1/projects/{projectId}/scan": [
    "post"
  ],
  "/v1/projects/{projectId}/secrets": [
    "get",
    "post"
  ],
  "/v1/projects/{projectId}/secrets/{secretId}": [
    "delete"
  ],
  "/v1/projects/{projectId}/secrets/{secretId}/rotate": [
    "post"
  ],
  "/v1/projects/{projectId}/specifications": [
    "post"
  ],
  "/v1/projects/{projectId}/specifications/{version}": [
    "get",
    "patch"
  ],
  "/v1/projects/{projectId}/specifications/{version}/approve": [
    "post"
  ],
  "/v1/projects/{projectId}/workspaces": [
    "post"
  ],
  "/v1/releases/{releaseId}": [
    "get"
  ],
  "/v1/releases/{releaseId}/approve": [
    "post"
  ],
  "/v1/releases/{releaseId}/deploy": [
    "post"
  ],
  "/v1/releases/{releaseId}/evidence": [
    "get"
  ],
  "/v1/releases/{releaseId}/rollback": [
    "post"
  ],
  "/v1/runs/{runId}": [
    "get"
  ],
  "/v1/runs/{runId}/cancel": [
    "post"
  ],
  "/v1/runs/{runId}/events": [
    "get"
  ],
  "/v1/runs/{runId}/pause": [
    "post"
  ],
  "/v1/runs/{runId}/redirect": [
    "post"
  ],
  "/v1/runs/{runId}/resume": [
    "post"
  ],
  "/v1/workspaces/{workspaceId}": [
    "get"
  ],
  "/v1/workspaces/{workspaceId}/checkpoint": [
    "post"
  ],
  "/v1/workspaces/{workspaceId}/preview": [
    "post"
  ],
  "/v1/workspaces/{workspaceId}/start": [
    "post"
  ],
  "/v1/workspaces/{workspaceId}/terminate": [
    "post"
  ]
} as const;
