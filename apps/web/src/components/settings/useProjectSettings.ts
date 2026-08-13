'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppSession, type AppSessionController } from '../../hooks/useAppSession';
import { createControlPlaneClient } from '../../lib/api';
import type {
  GitHubSync,
  OrganizationMembers,
  OrganizationSettings,
  ProjectIntegrations,
  ProjectSecrets,
  ProjectSettingsProject,
  ProjectSettingsSection,
  SettingsClient,
} from './settings-types';

export interface ProjectSettingsController {
  readonly canEditProject: boolean;
  readonly client: SettingsClient | undefined;
  readonly github: GitHubSync | undefined;
  readonly integrations: ProjectIntegrations | undefined;
  readonly isOwner: boolean;
  readonly members: OrganizationMembers | undefined;
  readonly organizationId: string | undefined;
  readonly projectData: ProjectSettingsProject | undefined;
  readonly projectId: string;
  readonly reload: () => void;
  readonly role: 'owner' | 'builder' | 'viewer' | undefined;
  readonly run: (work: () => Promise<unknown>, success: string) => Promise<boolean>;
  readonly section: ProjectSettingsSection;
  readonly secrets: ProjectSecrets | undefined;
  readonly session: AppSessionController;
  readonly settings: OrganizationSettings | undefined;
  readonly status: string;
}

export function useProjectSettings(
  projectId: string,
  section: ProjectSettingsSection,
): ProjectSettingsController {
  const session = useAppSession();
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [projectData, setProjectData] = useState<ProjectSettingsProject>();
  const [secrets, setSecrets] = useState<ProjectSecrets>();
  const [integrations, setIntegrations] = useState<ProjectIntegrations>();
  const [members, setMembers] = useState<OrganizationMembers>();
  const [settings, setSettings] = useState<OrganizationSettings>();
  const [github, setGitHub] = useState<GitHubSync>();
  const [loadStatus, setLoadStatus] = useState('Loading settings…');
  const [notice, setNotice] = useState('');
  const membership = session.snapshot.status === 'ready'
    ? session.snapshot.membership
    : undefined;
  const organizationId = membership?.organization.id;
  const role = membership?.role;
  const client = useMemo(
    () => organizationId === undefined ? undefined : createControlPlaneClient(organizationId),
    [organizationId],
  );

  useEffect(() => {
    setNotice('');
  }, [organizationId, projectId, section]);

  useEffect(() => {
    const abortController = new AbortController();
    const isActive = (): boolean => !abortController.signal.aborted;
    setProjectData(undefined);
    setSecrets(undefined);
    setIntegrations(undefined);
    setMembers(undefined);
    setSettings(undefined);
    setGitHub(undefined);

    if (session.snapshot.status === 'error') {
      setLoadStatus('Settings could not be loaded.');
      return () => {
        abortController.abort();
      };
    }
    if (client === undefined || membership === undefined) {
      setLoadStatus('Loading settings…');
      return () => {
        abortController.abort();
      };
    }

    setLoadStatus('Loading settings…');
    const load = async (): Promise<void> => {
      try {
        const project = await client.getProject(projectId, abortController.signal);
        if (!isActive()) return;
        setProjectData(project);

        if (membership.role !== 'viewer' && section === 'secrets') {
          const projectSecrets = await client.listProjectSecrets(projectId, abortController.signal);
          if (!isActive()) return;
          setSecrets(projectSecrets);
        }
        if (membership.role !== 'viewer' && section === 'github') {
          const sync = await client.getGitHubSyncState(projectId, abortController.signal);
          if (!isActive()) return;
          setGitHub(sync);
        }
        if (
          membership.role === 'owner'
          && (section === 'integrations' || section === 'payments')
        ) {
          const projectIntegrations = await client.listIntegrations(abortController.signal);
          if (!isActive()) return;
          setIntegrations(projectIntegrations);
        }
        if (membership.role === 'owner' && section === 'members') {
          const [directory, organizationSettings] = await Promise.all([
            client.listOrganizationMembers(membership.organization.id, abortController.signal),
            client.getOrganizationSettings(membership.organization.id, abortController.signal),
          ]);
          if (!isActive()) return;
          setMembers(directory);
          setSettings(organizationSettings);
        }
        if (isActive()) setLoadStatus('');
      } catch {
        if (!abortController.signal.aborted) {
          setNotice('');
          setLoadStatus('Settings could not be loaded.');
        }
      }
    };

    void load();
    return () => {
      abortController.abort();
    };
  }, [client, membership, projectId, reloadGeneration, section, session.snapshot.status]);

  const reload = useCallback((): void => {
    setReloadGeneration((value) => value + 1);
  }, []);

  const run = useCallback(async (
    work: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> => {
    setNotice('Saving…');
    try {
      await work();
      setNotice(success);
      setReloadGeneration((value) => value + 1);
      return true;
    } catch {
      setNotice('The change could not be saved.');
      return false;
    }
  }, []);

  return {
    canEditProject: role === 'owner' || role === 'builder',
    client,
    github,
    integrations,
    isOwner: role === 'owner',
    members,
    organizationId,
    projectData,
    projectId,
    reload,
    role,
    run,
    section,
    secrets,
    session,
    settings,
    status: notice === '' ? loadStatus : notice,
  };
}
