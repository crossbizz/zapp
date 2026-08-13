import type { createControlPlaneClient } from '../../lib/api';

export type ProjectSettingsSection =
  | 'general'
  | 'secrets'
  | 'integrations'
  | 'payments'
  | 'members'
  | 'github';

export type SettingsClient = ReturnType<typeof createControlPlaneClient>;
export type ProjectSettingsProject = Awaited<ReturnType<SettingsClient['getProject']>>;
export type ProjectSecrets = Awaited<ReturnType<SettingsClient['listProjectSecrets']>>;
export type ProjectIntegrations = Awaited<ReturnType<SettingsClient['listIntegrations']>>;
export type OrganizationMembers = Awaited<ReturnType<SettingsClient['listOrganizationMembers']>>;
export type GitHubSync = Awaited<ReturnType<SettingsClient['getGitHubSyncState']>>;
export type OrganizationSettings = Awaited<ReturnType<SettingsClient['getOrganizationSettings']>>;

export interface IntegrationField {
  readonly id:
    | 'accessToken'
    | 'accountId'
    | 'apiKey'
    | 'databaseName'
    | 'projectId'
    | 'projectName'
    | 'projectRef';
  readonly label: string;
  readonly placeholder: string;
  readonly secret: boolean;
}

export interface IntegrationCatalogEntry {
  readonly category: 'source' | 'data' | 'payments' | 'deployment';
  readonly description: string;
  readonly fields: readonly IntegrationField[];
  readonly provider: 'github' | 'supabase' | 'neon' | 'stripe' | 'vercel';
  readonly title: string;
}
