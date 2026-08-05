/** Generated from the live public OpenAPI document. Do not edit. */
export const PUBLIC_API_OPERATIONS = {
  "/v1/auth/callback": {
    "get": {
      "requiresAuth": false,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/auth/device": {
    "get": {
      "requiresAuth": false,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/auth/device/approve": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": []
    }
  },
  "/v1/auth/device/deny": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": []
    }
  },
  "/v1/auth/device/token": {
    "post": {
      "requiresAuth": false,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/auth/login": {
    "get": {
      "requiresAuth": false,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/auth/logout": {
    "post": {
      "requiresAuth": false,
      "successMediaTypes": []
    }
  },
  "/v1/auth/refresh": {
    "post": {
      "requiresAuth": false,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/integrations/github/install": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/integrations/neon/connect": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/integrations/stripe/connect": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/integrations/supabase/connect": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/invites/{token}/accept": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/me": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/organizations": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    },
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/organizations/{orgId}": {
    "patch": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/organizations/{orgId}/invites": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/organizations/{orgId}/members/{userId}": {
    "delete": {
      "requiresAuth": true,
      "successMediaTypes": []
    },
    "patch": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    },
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    },
    "patch": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/contract": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/releases": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/runs": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    },
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/scan": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/secrets": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    },
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/secrets/{secretId}": {
    "delete": {
      "requiresAuth": true,
      "successMediaTypes": []
    }
  },
  "/v1/projects/{projectId}/secrets/{secretId}/rotate": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/specifications": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/specifications/{version}": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    },
    "patch": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/specifications/{version}/approve": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/projects/{projectId}/workspaces": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/releases/{releaseId}": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/releases/{releaseId}/approve": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/releases/{releaseId}/deploy": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/releases/{releaseId}/evidence": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/releases/{releaseId}/rollback": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/runs/{runId}": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/runs/{runId}/cancel": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/runs/{runId}/events": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "text/event-stream"
      ]
    }
  },
  "/v1/runs/{runId}/pause": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/runs/{runId}/redirect": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/runs/{runId}/resume": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/workspaces/{workspaceId}": {
    "get": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/workspaces/{workspaceId}/checkpoint": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/workspaces/{workspaceId}/preview": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/workspaces/{workspaceId}/start": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  },
  "/v1/workspaces/{workspaceId}/terminate": {
    "post": {
      "requiresAuth": true,
      "successMediaTypes": [
        "application/json"
      ]
    }
  }
} as const;
