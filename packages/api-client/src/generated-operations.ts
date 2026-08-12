/** Generated from the live public OpenAPI document. Do not edit. */
export const PUBLIC_API_OPERATIONS = {
  "/v1/admin/organizations/{organizationId}/overview": {
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
  "/v1/admin/organizations/{organizationId}/runs/{runId}/diagnostics": {
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
  "/v1/admin/organizations/{organizationId}/runs/{runId}/terminate": {
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
  "/v1/admin/organizations/{organizationId}/terminate-all": {
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
  "/v1/admin/organizations/{organizationId}/workspaces/{workspaceId}/terminate": {
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
  "/v1/admin/support-sessions": {
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
  "/v1/attachments/{attachmentId}": {
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
  "/v1/billing/checkout": {
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
  "/v1/billing/estimate": {
    "post": {
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
  "/v1/billing/portal": {
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
  "/v1/billing/status": {
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
  "/v1/billing/subscription": {
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
  "/v1/billing/topups": {
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
  "/v1/billing/topups/checkout": {
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
  "/v1/feature-flags": {
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
  "/v1/forks": {
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
  "/v1/integrations": {
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
  "/v1/integrations/github/install/authorize": {
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
  "/v1/integrations/github/repositories": {
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
  "/v1/integrations/github/repositories/{repositoryId}/branches": {
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
  "/v1/integrations/vercel/connect": {
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
  "/v1/integrations/{connectionId}": {
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
  "/v1/local-agent/sessions": {
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
  "/v1/local-agent/sessions/{sessionId}/completions": {
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
            "text/event-stream"
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
  "/v1/notification-preferences": {
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
  "/v1/notification-preferences/{type}": {
    "put": {
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
        "202": {
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
  "/v1/organizations/{orgId}/members": {
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
  "/v1/projects/summaries": {
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
        "202": {
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
  "/v1/projects/{projectId}/attachments": {
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
  "/v1/projects/{projectId}/compare": {
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
  "/v1/projects/{projectId}/deletion": {
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
  "/v1/projects/{projectId}/export": {
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
  "/v1/projects/{projectId}/import/github": {
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
  "/v1/projects/{projectId}/incidents": {
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
  "/v1/projects/{projectId}/integrations/github": {
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
  "/v1/projects/{projectId}/integrations/github/export": {
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
  "/v1/projects/{projectId}/integrations/github/policy": {
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
  "/v1/projects/{projectId}/integrations/github/sync": {
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
  "/v1/releases/{releaseId}/fork": {
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
  "/v1/runs/{runId}/artifacts/{artifactId}": {
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
  "/v1/runs/{runId}/conversation-responses": {
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
  "/v1/runs/{runId}/evidence/{artifactId}": {
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
  "/v1/runs/{runId}/messages": {
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
  "/v1/runs/{runId}/phases/{phaseId}/skip": {
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
  "/v1/runs/{runId}/plans/{artifactId}": {
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
  "/v1/runs/{runId}/specifications/{specificationId}": {
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
  "/v1/runs/{runId}/tasks/{taskId}/retry": {
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
  "/v1/runs/{runId}/tests": {
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
  "/v1/templates": {
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
  "/v1/templates/{slug}": {
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
  "/v1/usage/summary": {
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
  "/v1/webhooks/github": {
    "post": {
      "security": [],
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
  "/v1/webhooks/grafana": {
    "post": {
      "security": [],
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
  "/v1/webhooks/stripe": {
    "post": {
      "security": [],
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
  "/v1/workspaces/{workspaceId}/dev-server/logs": {
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
  "/v1/workspaces/{workspaceId}/dev-server/restart": {
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
  "/v1/workspaces/{workspaceId}/edits": {
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
  "/v1/workspaces/{workspaceId}/file": {
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
  "/v1/workspaces/{workspaceId}/files": {
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
  "/v1/workspaces/{workspaceId}/preview/events": {
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
  "/v1/workspaces/{workspaceId}/preview/screenshot": {
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
            "image/png"
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
