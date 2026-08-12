import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AppInstance } from '../src/app.js';
import {
  createInMemoryPreviewSessionStore,
  createInMemoryPreviewShareStore,
} from '../src/routes/preview.js';
import { buildHarness } from './support/harness.js';
import { createInMemoryGitHubAuthorizationStateStore } from '../src/integrations/github/store.js';
import { createInMemoryGitHubWebhookStore } from '../src/integrations/github/queue.js';

const apps: AppInstance[] = [];

function documentedApp(): AppInstance {
  const built = buildHarness({
    admin: { enabled: false, staffUserIds: [] },
    usageLedger: {
      recordUsage: () => Promise.reject(new Error('OpenAPI must not record usage.')),
      getUsageSummary: () => Promise.reject(new Error('OpenAPI must not read usage.')),
    },
    // Route registration is declarative; this sentinel makes an accidental
    // database access during document creation loud without supplying a fake
    // data surface the routes could accidentally use.
    tenantDb: (() => {
      throw new Error('OpenAPI generation must not access the tenant database.');
    }),
    preview: {
      shares: createInMemoryPreviewShareStore(),
      sessions: createInMemoryPreviewSessionStore(),
      proxy: {
        request: () => Promise.reject(new Error('OpenAPI must not proxy preview traffic.')),
        openWebSocket: () => Promise.reject(new Error('OpenAPI must not proxy WebSockets.')),
      },
      signingKey: Buffer.alloc(32),
      keyVersion: 1,
      appBaseUrl: new URL('https://app.zapp.test'),
      previewBaseDomain: 'preview.zapp.test',
    },
    localAgent: {
      sessions: {
        ensure: () => Promise.reject(new Error('OpenAPI must not create local sessions.')),
        get: () => Promise.reject(new Error('OpenAPI must not read local sessions.')),
      },
      gateway: { async *stream() {} },
    },
    github: {
      appSlug: 'zapp-build-test',
      stateStore: createInMemoryGitHubAuthorizationStateStore(),
      provider: {
        completeInstallation: () => Promise.reject(new Error('OpenAPI must not call GitHub.')),
        listRepositories: () => Promise.reject(new Error('OpenAPI must not call GitHub.')),
        listBranches: () => Promise.reject(new Error('OpenAPI must not call GitHub.')),
      },
    },
    githubWebhook: {
      secret: 'openapi-test-secret',
      store: createInMemoryGitHubWebhookStore(),
    },
  });
  apps.push(built.app);
  return built.app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /v1/openapi.json', () => {
  it('publishes OpenAPI 3 schemas for public auth, project, run, and SSE routes', async () => {
    // Break caught: removing the public document route or registering OpenAPI
    // after the Zod routes would leave clients without typed API contracts.
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });

    expect(response.statusCode).toBe(200);
    const document: {
      openapi: string;
      components?: {
        securitySchemes?: Record<string, Record<string, unknown>>;
      };
      paths: Record<
        string,
        {
          get?: {
            parameters?: Array<{ in: string; name: string }>;
            responses?: Record<
              string,
              { content?: Record<string, { schema?: Record<string, unknown> }> }
            >;
            security?: Array<Record<string, string[]>>;
          };
          post?: {
            requestBody?: { content?: Record<string, unknown> };
            responses?: Record<string, unknown>;
            security?: Array<Record<string, string[]>>;
          };
        }
      >;
    } = response.json();

    expect(document.openapi).toMatch(/^3\.0\./);
    expect(document.paths['/v1/auth/login']?.get?.responses).toHaveProperty('302');
    expect(document.paths['/v1/projects']?.post?.requestBody?.content).toHaveProperty(
      'application/json',
    );
    expect(document.paths['/v1/runs/{runId}']?.get?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ in: 'path', name: 'runId' })]),
    );
    expect(document.paths['/v1/runs/{runId}/events']?.get?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ in: 'query', name: 'after' })]),
    );
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining([
      '/v1/projects',
      '/v1/projects/summaries',
      '/v1/organizations/{orgId}/audit-events',
      '/v1/organizations/{orgId}/settings',
      '/v1/workspaces/{workspaceId}/preview/shares',
      '/v1/projects/{projectId}/preview/shares',
      '/v1/organizations/{organizationId}/preview-shares/{shareId}/sessions',
      '/v1/preview/session',
      '/v1/runs/{runId}/mission-control',
      '/v1/runs/{runId}/mission-control/tool-calls',
      '/v1/runs/{runId}/mission-control/commits',
      '/v1/runs/{runId}/approvals/{approvalId}',
      '/v1/local-agent/sessions',
      '/v1/local-agent/sessions/{sessionId}/completions',
      '/v1/runs/{runId}/messages',
      '/v1/runs/{runId}/tasks/{taskId}/retry',
      '/v1/runs/{runId}/phases/{phaseId}/skip',
      '/v1/runs/{runId}/conversation-responses',
      '/v1/runs/{runId}/specifications/{specificationId}',
      '/v1/runs/{runId}/plans/{artifactId}',
      '/v1/runs/{runId}/artifacts/{artifactId}',
      '/v1/projects/{projectId}/attachments',
      '/v1/projects/{projectId}/export',
      '/v1/attachments/{attachmentId}',
      '/v1/workspaces/{workspaceId}/dev-server/logs',
      '/v1/workspaces/{workspaceId}/dev-server/restart',
      '/v1/workspaces/{workspaceId}/preview/events',
      '/v1/workspaces/{workspaceId}/preview/screenshot',
      '/v1/integrations/github/install/authorize',
      '/v1/integrations/github/install',
      '/v1/integrations/github/repositories',
      '/v1/integrations/github/repositories/{repositoryId}/branches',
      '/v1/projects/{projectId}/import/github',
      '/v1/webhooks/github',
      '/v1/feature-flags',
      '/v1/forks',
      '/v1/admin/support-sessions',
      '/v1/admin/organizations/{organizationId}/overview',
      '/v1/admin/organizations/{organizationId}/runs/{runId}/diagnostics',
      '/v1/admin/organizations/{organizationId}/runs/{runId}/terminate',
      '/v1/admin/organizations/{organizationId}/workspaces/{workspaceId}/terminate',
      '/v1/admin/organizations/{organizationId}/terminate-all',
      '/v1/releases/{releaseId}/fork',
    ]));
    expect(Object.keys(document.paths)).toHaveLength(89);
    expect(document.paths).toHaveProperty('/v1/projects/{projectId}/deletion');
    expect(document.paths['/v1/projects/{projectId}']).toHaveProperty('delete');
    expect(document.paths['/v1/organizations/{orgId}']).toHaveProperty('delete');
    expect(Object.keys(document.paths).every((path) => path.startsWith('/v1/'))).toBe(true);
  });

  it('publishes actual authentication, error, and structured SSE contracts', async () => {
    // Break caught: generated clients cannot know which credentials operations
    // require, cannot decode standard errors, or accept arbitrary SSE JSON.
    const response = await documentedApp().inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document: {
      components?: { securitySchemes?: Record<string, Record<string, unknown>> };
      paths: Record<
        string,
        {
          get?: {
            responses?: Record<
              string,
              { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }
            >;
            security?: Array<Record<string, string[]>>;
          };
          post?: {
            responses?: Record<string, unknown>;
            security?: Array<Record<string, string[]>>;
          };
        }
      >;
    } = response.json();

    expect(document.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: 'http', scheme: 'bearer' },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'zapp_session' },
      csrfToken: { type: 'apiKey', in: 'header', name: 'x-zapp-csrf' },
    });
    expect(document.paths['/v1/projects']?.get?.security).toEqual([
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    expect(document.paths['/v1/projects']?.post?.security).toEqual([
      { bearerAuth: [] },
      { sessionCookie: [], csrfToken: [] },
    ]);
    expect(document.paths['/v1/auth/login']?.get?.security).toBeUndefined();

    const projectErrors = document.paths['/v1/projects']?.get?.responses;
    expect(projectErrors).toHaveProperty('4XX');
    expect(projectErrors).toHaveProperty('5XX');
    expect(
      projectErrors?.['4XX']?.content?.['application/json']?.schema?.properties,
    ).toHaveProperty('error');

    const eventContent = document.paths['/v1/runs/{runId}/events']?.get?.responses?.['200']?.content;
    expect(eventContent).toHaveProperty('text/event-stream');
    const eventProperties = eventContent?.['text/event-stream']?.schema?.properties;
    expect(eventProperties).toHaveProperty('id');
    expect(eventProperties).toHaveProperty('runId');
    expect(eventProperties).toHaveProperty('sequence');
    expect(eventProperties).toHaveProperty('type');
    expect(eventProperties).toHaveProperty('payload');

    const completionContent = document.paths[
      '/v1/local-agent/sessions/{sessionId}/completions'
    ]?.post?.responses?.['200'] as
      | { content?: Record<string, { schema?: Record<string, unknown> }> }
      | undefined;
    expect(completionContent?.content).toHaveProperty('text/event-stream');
  });

  it('refuses an unrepresentable route schema instead of silently omitting it', () => {
    // Break caught: a route reaches production while its response cannot be
    // serialized or represented in the generated API contract.
    const app = documentedApp();
    expect(() => {
      app.get(
        '/v1/unrepresentable',
        { schema: { body: z.function().args().returns(z.string()) } },
        () => ({ ok: true }),
      );
    }).toThrow(/not supported/i);
  });
});
