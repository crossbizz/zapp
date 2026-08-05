/** Generated from the live public OpenAPI document. Do not edit. */
export const PUBLIC_API_OPERATIONS = {
  "/v1/auth/callback": {
    "get": {
      "authMode": "public",
      "successResponses": {
        "302": []
      }
    }
  },
  "/v1/auth/device": {
    "get": {
      "authMode": "public",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/auth/device/approve": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "204": []
      }
    }
  },
  "/v1/auth/device/deny": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "204": []
      }
    }
  },
  "/v1/auth/device/token": {
    "post": {
      "authMode": "public",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/auth/login": {
    "get": {
      "authMode": "public",
      "successResponses": {
        "302": []
      }
    }
  },
  "/v1/auth/logout": {
    "post": {
      "authMode": "optional",
      "successResponses": {
        "204": []
      }
    }
  },
  "/v1/auth/refresh": {
    "post": {
      "authMode": "optional",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/integrations/github/install": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/integrations/neon/connect": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/integrations/stripe/connect": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/integrations/supabase/connect": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/invites/{token}/accept": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/me": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/organizations": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    },
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/organizations/{orgId}": {
    "patch": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/organizations/{orgId}/invites": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/organizations/{orgId}/members/{userId}": {
    "delete": {
      "authMode": "required",
      "successResponses": {
        "204": []
      }
    },
    "patch": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    },
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    },
    "patch": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/contract": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/releases": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/runs": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    },
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/scan": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "202": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/secrets": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    },
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/secrets/{secretId}": {
    "delete": {
      "authMode": "required",
      "successResponses": {
        "204": []
      }
    }
  },
  "/v1/projects/{projectId}/secrets/{secretId}/rotate": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/specifications": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/specifications/{version}": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    },
    "patch": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/specifications/{version}/approve": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/projects/{projectId}/workspaces": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "201": [
          "application/json"
        ]
      }
    }
  },
  "/v1/releases/{releaseId}": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/releases/{releaseId}/approve": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/releases/{releaseId}/deploy": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/releases/{releaseId}/evidence": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/releases/{releaseId}/rollback": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/runs/{runId}": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/runs/{runId}/cancel": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/runs/{runId}/events": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "text/event-stream"
        ]
      }
    }
  },
  "/v1/runs/{runId}/pause": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/runs/{runId}/redirect": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/runs/{runId}/resume": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/workspaces/{workspaceId}": {
    "get": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/workspaces/{workspaceId}/checkpoint": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/workspaces/{workspaceId}/preview": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/workspaces/{workspaceId}/start": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  },
  "/v1/workspaces/{workspaceId}/terminate": {
    "post": {
      "authMode": "required",
      "successResponses": {
        "200": [
          "application/json"
        ]
      }
    }
  }
} as const;
