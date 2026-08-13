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
export type MissionControlData =
  paths['/v1/runs/{runId}/mission-control']['get']['responses'][200]['content']['application/json'];
export type ResolveApprovalInput =
  paths['/v1/runs/{runId}/approvals/{approvalId}']['post']['requestBody']['content']['application/json'];
export type ConversationCardResponseInput =
  paths['/v1/runs/{runId}/conversation-responses']['post']['requestBody']['content']['application/json'];
export type RunSpecificationData =
  paths['/v1/runs/{runId}/specifications/{specificationId}']['get']['responses'][200]['content']['application/json'];
export type RunPlanData =
  paths['/v1/runs/{runId}/plans/{artifactId}']['get']['responses'][200]['content']['application/json'];
export type WorkspaceFilesData =
  paths['/v1/workspaces/{workspaceId}/files']['get']['responses'][200]['content']['application/json'];
export type WorkspaceFileData =
  paths['/v1/workspaces/{workspaceId}/file']['get']['responses'][200]['content']['application/json'];
export type CommitComparisonData =
  paths['/v1/projects/{projectId}/compare']['get']['responses'][200]['content']['application/json'];
export type RunTestsData =
  paths['/v1/runs/{runId}/tests']['get']['responses'][200]['content']['application/json'];
export type RunEvidenceData =
  paths['/v1/runs/{runId}/evidence/{artifactId}']['get']['responses'][200]['content']['application/json'];
export type TemplateListData =
  paths['/v1/templates']['get']['responses'][200]['content']['application/json'];
export type TemplateDetailData =
  paths['/v1/templates/{slug}']['get']['responses'][200]['content']['application/json'];
export type ListIncidentsQuery =
  paths['/v1/projects/{projectId}/incidents']['get']['parameters']['query'];
export type UsageSummaryQuery = paths['/v1/usage/summary']['get']['parameters']['query'];
export type NotificationPreferenceType =
  paths['/v1/notification-preferences/{type}']['put']['parameters']['path']['type'];
export type NotificationPreferenceChannels =
  paths['/v1/notification-preferences/{type}']['put']['requestBody']['content']['application/json'];
export type AuditEventsQuery =
  paths['/v1/organizations/{orgId}/audit-events']['get']['parameters']['query'];
export type ReleaseReadinessData =
  paths['/v1/releases/{releaseId}']['get']['responses'][200]['content']['application/json']['readiness'];
export type DeploymentPreviewData =
  paths['/v1/releases/{releaseId}/deployment-preview']['get']['responses'][200]['content']['application/json'];
export type DeploymentProgressData =
  paths['/v1/deployments/{deploymentId}']['get']['responses'][200]['content']['application/json'];
export type StartSupportSessionInput =
  paths['/v1/admin/support-sessions']['post']['requestBody']['content']['application/json'];
export type AdminOverviewQuery = NonNullable<
  paths['/v1/admin/organizations/{organizationId}/overview']['get']['parameters']['query']
>;

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
    listTemplates: (signal?: AbortSignal) =>
      client.request('/v1/templates', {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      }),
    getTemplate: (slug: string, signal?: AbortSignal) =>
      client.request('/v1/templates/{slug}', {
        method: 'GET',
        path: { slug },
        ...(signal === undefined ? {} : { signal }),
      }),
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
    getProject: (projectId: string, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}', { method: 'GET', path: { projectId }, headers: headers(), ...(signal === undefined ? {} : { signal }) }),
    updateProject: (projectId: string, body: { readonly archived?: boolean }, idempotencyKey?: string) =>
      client.request('/v1/projects/{projectId}', { method: 'PATCH', path: { projectId }, headers: headers(true, true, idempotencyKey), body }),
    deleteProject: (projectId: string, idempotencyKey?: string) =>
      client.request('/v1/projects/{projectId}', { method: 'DELETE', path: { projectId }, headers: requiredKeyHeaders(idempotencyKey) }),
    listProjectSecrets: (projectId: string, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}/secrets', { method: 'GET', path: { projectId }, headers: headers(), query: { limit: 100 }, ...(signal === undefined ? {} : { signal }) }),
    createProjectSecret: (projectId: string, body: { readonly name: string; readonly value: string; readonly environmentId?: string }) =>
      client.request('/v1/projects/{projectId}/secrets', { method: 'POST', path: { projectId }, headers: headers(true, false), body }),
    rotateProjectSecret: (projectId: string, secretId: string, value: string) =>
      client.request('/v1/projects/{projectId}/secrets/{secretId}/rotate', { method: 'POST', path: { projectId, secretId }, headers: headers(true, false), body: { value } }),
    listIntegrations: (signal?: AbortSignal) =>
      client.request('/v1/integrations', { method: 'GET', headers: headers(), ...(signal === undefined ? {} : { signal }) }),
    disconnectIntegration: (connectionId: string, idempotencyKey?: string) =>
      client.request('/v1/integrations/{connectionId}', { method: 'DELETE', path: { connectionId }, headers: requiredKeyHeaders(idempotencyKey) }),
    connectSupabase: (projectId: string, accessToken: string, projectRef: string, idempotencyKey?: string) =>
      client.request('/v1/integrations/supabase/connect', { method: 'POST', headers: requiredKeyHeaders(idempotencyKey), body: { projectId, accessToken, configuration: { projectRef } } }),
    connectNeon: (projectId: string, apiKey: string, providerProjectId: string, databaseName: string, idempotencyKey?: string) =>
      client.request('/v1/integrations/neon/connect', { method: 'POST', headers: requiredKeyHeaders(idempotencyKey), body: { projectId, apiKey, configuration: { projectId: providerProjectId, databaseName } } }),
    connectStripe: (projectId: string, apiKey: string, accountId: string, idempotencyKey?: string) =>
      client.request('/v1/integrations/stripe/connect', { method: 'POST', headers: requiredKeyHeaders(idempotencyKey), body: { projectId, apiKey, configuration: { accountId, mode: 'test' } } }),
    connectVercel: (projectId: string, accessToken: string, providerProjectId: string, projectName: string, idempotencyKey?: string) =>
      client.request('/v1/integrations/vercel/connect', { method: 'POST', headers: requiredKeyHeaders(idempotencyKey), body: { projectId, accessToken, configuration: { projectId: providerProjectId, projectName } } }),
    listOrganizationMembers: (organizationId: string, signal?: AbortSignal) =>
      client.request('/v1/organizations/{orgId}/members', { method: 'GET', path: { orgId: organizationId }, ...(signal === undefined ? {} : { signal }) }),
    inviteOrganizationMember: (organizationId: string, body: { readonly email: string; readonly role: 'owner' | 'builder' | 'viewer' }) =>
      client.request('/v1/organizations/{orgId}/invites', { method: 'POST', path: { orgId: organizationId }, headers: headers(true, false), body }),
    updateOrganizationMember: (organizationId: string, userId: string, role: 'owner' | 'builder' | 'viewer') =>
      client.request('/v1/organizations/{orgId}/members/{userId}', { method: 'PATCH', path: { orgId: organizationId, userId }, headers: headers(true, false), body: { role } }),
    getOrganizationSettings: (organizationId: string, signal?: AbortSignal) =>
      client.request('/v1/organizations/{orgId}/settings', { method: 'GET', path: { orgId: organizationId }, headers: headers(), ...(signal === undefined ? {} : { signal }) }),
    updateOrganizationSettings: (organizationId: string, builderCanDeploy: boolean, idempotencyKey?: string) =>
      client.request('/v1/organizations/{orgId}/settings', { method: 'PATCH', path: { orgId: organizationId }, headers: requiredKeyHeaders(idempotencyKey), body: { builderCanDeploy } }),
    getGitHubSyncState: (projectId: string, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}/integrations/github', { method: 'GET', path: { projectId }, headers: headers(), ...(signal === undefined ? {} : { signal }) }),
    updateGitHubSyncPolicy: (projectId: string, syncPolicy: 'direct_push' | 'pull_request', idempotencyKey?: string) =>
      client.request('/v1/projects/{projectId}/integrations/github/policy', { method: 'PATCH', path: { projectId }, headers: requiredKeyHeaders(idempotencyKey), body: { syncPolicy } }),
    syncGitHubNow: (projectId: string, idempotencyKey?: string) =>
      client.request('/v1/projects/{projectId}/integrations/github/sync', { method: 'POST', path: { projectId }, headers: requiredKeyHeaders(idempotencyKey) }),
    exportToGitHub: (projectId: string, body: { readonly installationId: string; readonly repositoryName: string; readonly private: boolean; readonly syncPolicy: 'direct_push' | 'pull_request' }, idempotencyKey?: string) =>
      client.request('/v1/projects/{projectId}/integrations/github/export', { method: 'POST', path: { projectId }, headers: requiredKeyHeaders(idempotencyKey), body }),
    listProjectReleases: (projectId: string, cursor?: string, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}/releases', { method: 'GET', path: { projectId }, headers: headers(), query: { limit: 20, ...(cursor === undefined ? {} : { cursor }) }, ...(signal === undefined ? {} : { signal }) }),
    getRelease: (releaseId: string, signal?: AbortSignal) =>
      client.request('/v1/releases/{releaseId}', { method: 'GET', path: { releaseId }, headers: headers(), ...(signal === undefined ? {} : { signal }) }),
    getReleaseEvidence: (releaseId: string, signal?: AbortSignal) =>
      client.request('/v1/releases/{releaseId}/evidence', { method: 'GET', path: { releaseId }, headers: headers(), ...(signal === undefined ? {} : { signal }) }),
    getDeploymentPreview: (releaseId: string, retarget = false, signal?: AbortSignal) =>
      client.request('/v1/releases/{releaseId}/deployment-preview', { method: 'GET', path: { releaseId }, headers: headers(), query: { retarget }, ...(signal === undefined ? {} : { signal }) }),
    runReadinessAction: (releaseId: string, body: { readonly findingId: string; readonly action: 'fix' | 'review' | 'waive'; readonly reason?: string }, idempotencyKey?: string) =>
      client.request('/v1/releases/{releaseId}/readiness-actions', { method: 'POST', path: { releaseId }, headers: requiredKeyHeaders(idempotencyKey), body }),
    approveRelease: (releaseId: string, idempotencyKey?: string) =>
      client.request('/v1/releases/{releaseId}/approve', { method: 'POST', path: { releaseId }, headers: requiredKeyHeaders(idempotencyKey) }),
    deployRelease: (releaseId: string, body: { readonly deploymentType: 'first_deploy' | 'redeploy' | 'replace_deployment'; readonly dataDisposition?: 'preserve' | 'transfer' | 'reset' }, idempotencyKey?: string) =>
      client.request('/v1/releases/{releaseId}/deploy', { method: 'POST', path: { releaseId }, headers: requiredKeyHeaders(idempotencyKey), body }),
    getDeployment: (deploymentId: string, signal?: AbortSignal) =>
      client.request('/v1/deployments/{deploymentId}', { method: 'GET', path: { deploymentId }, headers: headers(), ...(signal === undefined ? {} : { signal }) }),
    runDeploymentAction: (deploymentId: string, body: { readonly action: 'retry' | 'fix' | 'ask'; readonly stage?: string; readonly prompt?: string }, idempotencyKey?: string) =>
      client.request('/v1/deployments/{deploymentId}/actions', { method: 'POST', path: { deploymentId }, headers: requiredKeyHeaders(idempotencyKey), body }),
    forkRelease: (releaseId: string, idempotencyKey?: string) =>
      client.request('/v1/releases/{releaseId}/fork', { method: 'POST', path: { releaseId }, headers: requiredKeyHeaders(idempotencyKey), body: { startFixRun: true } }),
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
    startSupportSession: (body: StartSupportSessionInput, idempotencyKey?: string) =>
      client.request('/v1/admin/support-sessions', {
        method: 'POST',
        headers: requiredKeyHeaders(idempotencyKey),
        body,
      }),
    getAdminOverview: (
      targetOrganizationId: string,
      query: AdminOverviewQuery,
      supportSession: string,
      signal?: AbortSignal,
    ) =>
      client.request('/v1/admin/organizations/{organizationId}/overview', {
        method: 'GET',
        path: { organizationId: targetOrganizationId },
        headers: { 'x-zapp-support-session': supportSession },
        query,
        ...(signal === undefined ? {} : { signal }),
      }),
    getAdminRunDiagnostics: (
      targetOrganizationId: string,
      runId: string,
      supportSession: string,
      signal?: AbortSignal,
    ) =>
      client.request(
        '/v1/admin/organizations/{organizationId}/runs/{runId}/diagnostics',
        {
          method: 'GET',
          path: { organizationId: targetOrganizationId, runId },
          headers: { 'x-zapp-support-session': supportSession },
          ...(signal === undefined ? {} : { signal }),
        },
      ),
    terminateAdminRun: (
      targetOrganizationId: string,
      runId: string,
      supportSession: string,
      idempotencyKey?: string,
    ) =>
      client.request('/v1/admin/organizations/{organizationId}/runs/{runId}/terminate', {
        method: 'POST',
        path: { organizationId: targetOrganizationId, runId },
        headers: {
          ...requiredKeyHeaders(idempotencyKey),
          'x-zapp-support-session': supportSession,
        },
      }),
    terminateAdminWorkspace: (
      targetOrganizationId: string,
      workspaceId: string,
      supportSession: string,
      idempotencyKey?: string,
    ) =>
      client.request(
        '/v1/admin/organizations/{organizationId}/workspaces/{workspaceId}/terminate',
        {
          method: 'POST',
          path: { organizationId: targetOrganizationId, workspaceId },
          headers: {
            ...requiredKeyHeaders(idempotencyKey),
            'x-zapp-support-session': supportSession,
          },
        },
      ),
    terminateAdminOrganizationSandboxes: (
      targetOrganizationId: string,
      supportSession: string,
      idempotencyKey?: string,
    ) =>
      client.request('/v1/admin/organizations/{organizationId}/terminate-all', {
        method: 'POST',
        path: { organizationId: targetOrganizationId },
        headers: {
          ...requiredKeyHeaders(idempotencyKey),
          'x-zapp-support-session': supportSession,
        },
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
    getMissionControl: (runId: string, signal?: AbortSignal) =>
      client.request('/v1/runs/{runId}/mission-control', {
        method: 'GET',
        path: { runId },
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    pauseRun: (runId: string, idempotencyKey?: string) =>
      client.request('/v1/runs/{runId}/pause', {
        method: 'POST',
        path: { runId },
        headers: headers(true, true, idempotencyKey),
      }),
    resumeRun: (runId: string, idempotencyKey?: string) =>
      client.request('/v1/runs/{runId}/resume', {
        method: 'POST',
        path: { runId },
        headers: headers(true, true, idempotencyKey),
      }),
    redirectRun: (runId: string, prompt: string, idempotencyKey?: string) =>
      client.request('/v1/runs/{runId}/redirect', {
        method: 'POST',
        path: { runId },
        headers: headers(true, true, idempotencyKey),
        body: { prompt },
      }),
    retryRunTask: (runId: string, taskId: string, idempotencyKey?: string) =>
      client.request('/v1/runs/{runId}/tasks/{taskId}/retry', {
        method: 'POST',
        path: { runId, taskId },
        headers: headers(true, true, idempotencyKey),
      }),
    skipRunPhase: (runId: string, phaseId: string, idempotencyKey?: string) =>
      client.request('/v1/runs/{runId}/phases/{phaseId}/skip', {
        method: 'POST',
        path: { runId, phaseId },
        headers: headers(true, true, idempotencyKey),
      }),
    resolveRunApproval: (
      runId: string,
      approvalId: string,
      body: ResolveApprovalInput,
      idempotencyKey?: string,
    ) =>
      client.request('/v1/runs/{runId}/approvals/{approvalId}', {
        method: 'POST',
        path: { runId, approvalId },
        headers: headers(true, true, idempotencyKey),
        body,
      }),
    answerConversationCard: (
      runId: string,
      body: ConversationCardResponseInput,
      idempotencyKey?: string,
    ) =>
      client.request('/v1/runs/{runId}/conversation-responses', {
        method: 'POST',
        path: { runId },
        headers: headers(true, true, idempotencyKey),
        body,
      }),
    getRunSpecification: (runId: string, specificationId: string, signal?: AbortSignal) =>
      client.request('/v1/runs/{runId}/specifications/{specificationId}', {
        method: 'GET',
        path: { runId, specificationId },
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    getRunPlan: (runId: string, artifactId: string, signal?: AbortSignal) =>
      client.request('/v1/runs/{runId}/plans/{artifactId}', {
        method: 'GET',
        path: { runId, artifactId },
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    listProjectWorkspaces: (projectId: string, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}/workspaces', {
        method: 'GET',
        path: { projectId },
        headers: headers(),
        query: { limit: 25 },
        ...(signal === undefined ? {} : { signal }),
      }),
    listWorkspaceFiles: (workspaceId: string, path = '.', signal?: AbortSignal) =>
      client.request('/v1/workspaces/{workspaceId}/files', {
        method: 'GET',
        path: { workspaceId },
        headers: headers(),
        query: { path, maxDepth: 1 },
        ...(signal === undefined ? {} : { signal }),
      }),
    readWorkspaceFile: (workspaceId: string, path: string, signal?: AbortSignal) =>
      client.request('/v1/workspaces/{workspaceId}/file', {
        method: 'GET',
        path: { workspaceId },
        headers: headers(),
        query: { path },
        ...(signal === undefined ? {} : { signal }),
      }),
    editWorkspaceFile: (
      workspaceId: string,
      body: { readonly path: string; readonly dataBase64: string; readonly expectedCompareToken: string },
      idempotencyKey?: string,
    ) =>
      client.request('/v1/workspaces/{workspaceId}/edits', {
        method: 'POST',
        path: { workspaceId },
        headers: requiredKeyHeaders(idempotencyKey),
        body,
      }),
    compareProjectCommits: (projectId: string, before: string, after: string, signal?: AbortSignal) =>
      client.request('/v1/projects/{projectId}/compare', {
        method: 'GET',
        path: { projectId },
        headers: headers(),
        query: { before, after },
        ...(signal === undefined ? {} : { signal }),
      }),
    listRunTests: (runId: string, signal?: AbortSignal) =>
      client.request('/v1/runs/{runId}/tests', {
        method: 'GET',
        path: { runId },
        headers: headers(),
        ...(signal === undefined ? {} : { signal }),
      }),
    getRunEvidence: (runId: string, artifactId: string, taskId?: string, signal?: AbortSignal) =>
      client.request('/v1/runs/{runId}/evidence/{artifactId}', {
        method: 'GET',
        path: { runId, artifactId },
        headers: headers(),
        query: taskId === undefined ? {} : { taskId },
        ...(signal === undefined ? {} : { signal }),
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
