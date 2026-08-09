/** Generated from the live public OpenAPI document. Do not edit. */
export const PUBLIC_API_OPERATIONS = {
  "/v1/auth/callback": {
    "get": {
      "security": [],
      "successResponses": {
        "302": {
          "body": "forbidden",
          "mediaTypes": [],
          "requiredHeaders": [
            "Location"
          ]
        }
      }
    }
  },
  "/v1/auth/device": {
    "get": {
      "security": [],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/auth/device/approve": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "204": {
          "body": "forbidden",
          "mediaTypes": [],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/auth/device/deny": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "204": {
          "body": "forbidden",
          "mediaTypes": [],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/auth/device/token": {
    "post": {
      "security": [],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/auth/login": {
    "get": {
      "security": [],
      "successResponses": {
        "302": {
          "body": "forbidden",
          "mediaTypes": [],
          "requiredHeaders": [
            "Location"
          ]
        }
      }
    }
  },
  "/v1/auth/logout": {
    "post": {
      "security": [
        {},
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        },
        {
          "refreshCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "204": {
          "body": "forbidden",
          "mediaTypes": [],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/auth/refresh": {
    "post": {
      "security": [
        {},
        {
          "refreshCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/integrations/github/install": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/integrations/neon/connect": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/integrations/stripe/connect": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/integrations/supabase/connect": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/invites/{token}/accept": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/me": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/organizations": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    },
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/organizations/{orgId}": {
    "patch": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/organizations/{orgId}/audit-events": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/organizations/{orgId}/invites": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/organizations/{orgId}/members/{userId}": {
    "delete": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "204": {
          "body": "forbidden",
          "mediaTypes": [],
          "requiredHeaders": []
        }
      }
    },
    "patch": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/organizations/{orgId}/settings": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    },
    "patch": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/organizations/{organizationId}/preview-shares/{shareId}/sessions": {
    "post": {
      "security": [
        {},
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/preview/session": {
    "post": {
      "security": [],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    },
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    },
    "patch": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/contract": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/preview/shares": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/releases": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/runs": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    },
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/scan": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "202": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/secrets": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    },
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/secrets/{secretId}": {
    "delete": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "204": {
          "body": "forbidden",
          "mediaTypes": [],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/secrets/{secretId}/rotate": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/specifications": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/specifications/{version}": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    },
    "patch": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/specifications/{version}/approve": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/projects/{projectId}/workspaces": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/releases/{releaseId}": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/releases/{releaseId}/approve": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/releases/{releaseId}/deploy": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/releases/{releaseId}/evidence": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/releases/{releaseId}/rollback": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/approvals/{approvalId}": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/cancel": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/events": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "text/event-stream"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/mission-control": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/mission-control/commits": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/mission-control/tool-calls": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/pause": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/redirect": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/runs/{runId}/resume": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/workspaces/{workspaceId}": {
    "get": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/workspaces/{workspaceId}/checkpoint": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/workspaces/{workspaceId}/preview/shares": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "201": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/workspaces/{workspaceId}/preview/shares/{shareId}": {
    "delete": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/workspaces/{workspaceId}/start": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  },
  "/v1/workspaces/{workspaceId}/terminate": {
    "post": {
      "security": [
        {
          "bearerAuth": []
        },
        {
          "sessionCookie": [],
          "csrfToken": []
        }
      ],
      "successResponses": {
        "200": {
          "body": "required",
          "mediaTypes": [
            "application/json"
          ],
          "requiredHeaders": []
        }
      }
    }
  }
} as const;
