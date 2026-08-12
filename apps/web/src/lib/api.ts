import {
  createZappClient,
  type FetchImplementation,
  type SubscribePreviewEventsOptions,
  type SubscribeRunEventsOptions,
  type paths,
} from '@zapp/api-client';

const csrfCookieName = 'zapp_csrf';
const csrfHeaderName = 'x-zapp-csrf';
const idempotencyHeaderName = 'idempotency-key';

export type CreateProjectInput =
  paths['/v1/projects']['post']['requestBody']['content']['application/json'];
export type CreateRunInput =
  paths['/v1/projects/{projectId}/runs']['post']['requestBody']['content']['application/json'];
export type ListProjectsQuery = NonNullable<paths['/v1/projects']['get']['parameters']['query']>;
export type ProjectSummariesQuery = paths['/v1/projects/summaries']['get']['parameters']['query'];
export type CompleteGitHubInstallInput =
  paths['/v1/integrations/github/install']['post']['requestBody']['content']['application/json'];
export type ListGitHubRepositoriesQuery =
  paths['/v1/integrations/github/repositories']['get']['parameters']['query'];
export type ListGitHubBranchesQuery =
  paths['/v1/integrations/github/repositories/{repositoryId}/branches']['get']['parameters']['query'];
export type EnqueueGitHubImportInput =
  paths['/v1/projects/{projectId}/import/github']['post']['requestBody']['content']['application/json'];
export type CreateRunMessageInput =
  paths['/v1/runs/{runId}/messages']['post']['requestBody']['content']['application/json'];
export type ListIncidentsQuery =
  paths['/v1/projects/{projectId}/incidents']['get']['parameters']['query'];
export type UsageSummaryQuery = paths['/v1/usage/summary']['get']['parameters']['query'];
export type NotificationPreferenceType =
  paths['/v1/notification-preferences/{type}']['put']['parameters']['path']['type'];
export type NotificationPreferenceChannels =
  paths['/v1/notification-preferences/{type}']['put']['requestBody']['content']['application/json'];
export type AuditEventsQuery =
  paths['/v1/organizations/{orgId}/audit-events']['get']['parameters']['query'];

function controlPlaneUrl(): string {
  const value = process.env.NEXT_PUBLIC_CONTROL_API_URL;
  if (value === undefined || value.length === 0) {
    throw new Error('NEXT_PUBLIC_CONTROL_API_URL must be configured.');
  }
  return value;
}

function csrfToken(): string {
  const value = document.cookie
    .split('; ')
    .find((item) => item.startsWith(`${csrfCookieName}=`))
    ?.slice(csrfCookieName.length + 1);
  if (value === undefined || value.length === 0) {
    throw new Error('The CSRF session cookie is missing.');
  }
  return decodeURIComponent(value);
}

const browserFetch: FetchImplementation = async (input, init) => {
  const response = await fetch(input, init);
  // Chromium exposes a CORS 204 as an empty stream. The generated client
  // correctly requires a null body for an OpenAPI no-content response.
  if (response.status !== 204) return response;
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: null,
    text: () => response.text(),
  };
};

/**
 * The only control-plane boundary used by browser components. Cookie credentials
 * are selected by the generated client from each public OpenAPI operation.
 */
export function createControlPlaneClient(organizationId?: string) {
  const scopedFetch: FetchImplementation = async (input, init) => {
    const scopedHeaders = new Headers(init.headers);
    if (organizationId !== undefined) scopedHeaders.set('x-organization-id', organizationId);
    return await browserFetch(input, { ...init, headers: scopedHeaders });
  };
  const client = createZappClient({
    baseUrl: controlPlaneUrl(),
    getToken: () => '',
    fetch: scopedFetch,
  });
  const organizationHeaders =
    organizationId === undefined ? undefined : { 'x-organization-id': organizationId };
  const headers = (
    mutating = false,
    keyed = mutating,
    idempotencyKey?: string,
  ): Record<string, string> => ({
    ...(organizationHeaders ?? {}),
    ...(mutating
      ? {
          [csrfHeaderName]: csrfToken(),
        }
      : {}),
    ...(keyed ? { [idempotencyHeaderName]: idempotencyKey ?? crypto.randomUUID() } : {}),
  });
  const requiredKeyHeaders = (
    idempotencyKey?: string,
  ): Record<string, string> & { readonly 'idempotency-key': string } => ({
    ...headers(true, false),
    'idempotency-key': idempotencyKey ?? crypto.randomUUID(),
  });

  return {
    getMe: () =>
      client.request('/v1/me', {
        method: 'GET',
        ...(organizationHeaders === undefined ? {} : { headers: headers() }),
      }),
    getFeatureFlags: () =>
      client.request('/v1/feature-flags', {
        method: 'GET',
        headers: headers(),
      }),
    listProjects: (query: ListProjectsQuery = {}, signal?: AbortSignal) =>
      client.request('/v1/projects', {
        method: 'GET',
        headers: headers(),
        query,
        ...(signal === undefined ? {} : { signal }),
      }),
    getProjectSummaries: (query: ProjectSummariesQuery, signal?: AbortSignal) =>
      client.request('/v1/projects/summaries', {
        method: 'GET',
        headers: headers(),
        query,
        ...(signal === undefined ? {} : { signal }),
      }),
    createProject: (body: CreateProjectInput, idempotencyKey?: string, signal?: AbortSignal) =>
      client.request('/v1/projects', {
        method: 'POST',
        headers: requiredKeyHeaders(idempotencyKey),
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    authorizeGitHubInstall: (idempotencyKey?: string, signal?: AbortSignal) => {
      const operationKey = idempotencyKey ?? crypto.randomUUID();
      return client.request('/v1/integrations/github/install/authorize', {
        method: 'POST',
        headers: {
          ...headers(true, false),
          [idempotencyHeaderName]: operationKey,
        },
        ...(signal === undefined ? {} : { signal }),
      });
    },
    completeGitHubInstall: (
      body: CompleteGitHubInstallInput,
      idempotencyKey?: string,
      signal?: AbortSignal,
    ) =>
      client.request('/v1/integrations/github/install', {
        method: 'POST',
        headers: headers(true, true, idempotencyKey),
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    listGitHubRepositories: (query: ListGitHubRepositoriesQuery, signal?: AbortSignal) =>
      client.request('/v1/integrations/github/repositories', {
        method: 'GET',
        headers: headers(),
        query,
        ...(signal === undefined ? {} : { signal }),
      }),
    listGitHubBranches: (
      repositoryId: string,
      query: ListGitHubBranchesQuery,
      signal?: AbortSignal,
    ) =>
      client.request('/v1/integrations/github/repositories/{repositoryId}/branches', {
        method: 'GET',
        path: { repositoryId },
        headers: headers(),
        query,
        ...(signal === undefined ? {} : { signal }),
      }),
    enqueueGitHubImport: (
      projectId: string,
      body: EnqueueGitHubImportInput,
      idempotencyKey: string,
      signal?: AbortSignal,
    ) =>
      client.request('/v1/projects/{projectId}/import/github', {
        method: 'POST',
        path: { projectId },
        headers: {
          ...headers(true, true, idempotencyKey),
          [idempotencyHeaderName]: idempotencyKey,
        },
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    getGitHubImport: (projectId: string, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}/import/github', {
        method: 'GET',
        path: { projectId },
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    createRun: (projectId: string, body: CreateRunInput, idempotencyKey?: string) =>
      client.request('/v1/projects/{projectId}/runs', {
        method: 'POST',
        path: { projectId },
        headers: requiredKeyHeaders(idempotencyKey),
        body,
      }),
    listRuns: (projectId: string, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}/runs', {
        method: 'GET',
        path: { projectId },
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    listIncidents: (projectId: string, query: ListIncidentsQuery = {}, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}/incidents', {
        method: 'GET',
        path: { projectId },
        headers: headers(),
        query,
        ...(signal === undefined ? {} : { signal }),
      }),
    getUsageSummary: (query: UsageSummaryQuery, signal?: AbortSignal) =>
      client.request('/v1/usage/summary', {
        method: 'GET',
        headers: headers(),
        query,
        ...(signal === undefined ? {} : { signal }),
      }),
    getNotificationPreferences: (signal?: AbortSignal) =>
      client.request('/v1/notification-preferences', {
        method: 'GET',
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    setNotificationPreference: (
      type: NotificationPreferenceType,
      body: NotificationPreferenceChannels,
      signal?: AbortSignal,
    ) =>
      client.request('/v1/notification-preferences/{type}', {
        method: 'PUT',
        path: { type },
        headers: headers(true, false),
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    getBillingStatus: (signal?: AbortSignal) =>
      client.request('/v1/billing/status', {
        method: 'GET',
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    updateBillingSeats: (seats: number, idempotencyKey?: string) =>
      client.request('/v1/billing/subscription', {
        method: 'PATCH',
        headers: headers(true, true, idempotencyKey),
        body: { seats },
      }),
    createBillingPortal: (idempotencyKey?: string) =>
      client.request('/v1/billing/portal', {
        method: 'POST',
        headers: headers(true, true, idempotencyKey),
      }),
    listCreditPacks: (signal?: AbortSignal) =>
      client.request('/v1/billing/topups', {
        method: 'GET',
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    createTopupCheckout: (packId: string, idempotencyKey?: string) =>
      client.request('/v1/billing/topups/checkout', {
        method: 'POST',
        headers: headers(true, true, idempotencyKey),
        body: { packId },
      }),
    listAuditEvents: (organizationId: string, query: AuditEventsQuery = {}, signal?: AbortSignal) =>
      client.request('/v1/organizations/{orgId}/audit-events', {
        method: 'GET',
        path: { orgId: organizationId },
        headers: headers(),
        query,
        ...(signal === undefined ? {} : { signal }),
      }),
    sendRunMessage: (runId: string, body: CreateRunMessageInput, idempotencyKey?: string) =>
      client.request('/v1/runs/{runId}/messages', {
        method: 'POST',
        path: { runId },
        headers: headers(true, true, idempotencyKey),
        body,
      }),
    uploadAttachment: (projectId: string, file: File, idempotencyKey?: string) => {
      const body = new FormData();
      body.append('file', file, file.name);
      return client.request('/v1/projects/{projectId}/attachments', {
        method: 'POST',
        path: { projectId },
        headers: headers(true, true, idempotencyKey),
        body,
      });
    },
    cancelRun: (runId: string, idempotencyKey?: string) =>
      client.request('/v1/runs/{runId}/cancel', {
        method: 'POST',
        path: { runId },
        headers: headers(true, true, idempotencyKey),
      }),
    readDevServerLogs: (workspaceId: string, after = 0, signal?: AbortSignal) =>
      client.request('/v1/workspaces/{workspaceId}/dev-server/logs', {
        method: 'GET',
        path: { workspaceId },
        headers: headers(),
        query: { after, limit: 100 },
        ...(signal === undefined ? {} : { signal }),
      }),
    restartDevServer: (workspaceId: string, idempotencyKey?: string) =>
      client.request('/v1/workspaces/{workspaceId}/dev-server/restart', {
        method: 'POST',
        path: { workspaceId },
        headers: requiredKeyHeaders(idempotencyKey),
      }),
    startWorkspace: (workspaceId: string, idempotencyKey?: string) =>
      client.request('/v1/workspaces/{workspaceId}/start', {
        method: 'POST',
        path: { workspaceId },
        headers: headers(true, true, idempotencyKey),
      }),
    createPreviewShare: (
      workspaceId: string,
      policy: 'anyone_with_link' | 'org',
      idempotencyKey?: string,
    ) =>
      client.request('/v1/workspaces/{workspaceId}/preview/shares', {
        method: 'POST',
        path: { workspaceId },
        headers: headers(true, true, idempotencyKey),
        body: { expiresInSeconds: 8 * 60 * 60, policy },
      }),
    capturePreviewScreenshot: (workspaceId: string, idempotencyKey?: string) =>
      client.request('/v1/workspaces/{workspaceId}/preview/screenshot', {
        method: 'POST',
        path: { workspaceId },
        headers: requiredKeyHeaders(idempotencyKey),
      }),
    subscribeRunEvents: (runId: string, options: SubscribeRunEventsOptions) =>
      client.subscribeRunEvents(runId, options),
    subscribePreviewEvents: (workspaceId: string, options: SubscribePreviewEventsOptions) =>
      client.subscribePreviewEvents(workspaceId, options),
    logout: () =>
      client.request('/v1/auth/logout', {
        method: 'POST',
        headers: headers(true, false),
      }),
    approveDevice: (userCode: string) =>
      client.request('/v1/auth/device/approve', {
        method: 'POST',
        headers: { [csrfHeaderName]: csrfToken() },
        body: { userCode },
      }),
    denyDevice: (userCode: string) =>
      client.request('/v1/auth/device/deny', {
        method: 'POST',
        headers: { [csrfHeaderName]: csrfToken() },
        body: { userCode },
      }),
  };
}

export type MeResponse = Awaited<ReturnType<ReturnType<typeof createControlPlaneClient>['getMe']>>;
export type FeatureFlagsResponse = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getFeatureFlags']>
>;
export type BuilderRun = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['listRuns']>
>['items'][number];
export type ProjectIncident = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['listIncidents']>
>['items'][number];
