'use client';

import type { ReactElement } from 'react';

import { AppShell } from '../shell/AppShell';
import { GeneralSettings } from './GeneralSettings';
import { GitHubSettings } from './GitHubSettings';
import { IntegrationsSettings } from './IntegrationsSettings';
import { MembersSettings } from './MembersSettings';
import { PaymentsSettings } from './PaymentsSettings';
import { SecretsSettings } from './SecretsSettings';
import { SettingsLayout } from './SettingsLayout';
import type { ProjectSettingsSection } from './settings-types';
import { useProjectSettings } from './useProjectSettings';

export interface ProjectSettingsPanelProps {
  readonly embedded?: boolean;
  readonly onSectionChange?: ((section: ProjectSettingsSection) => void) | undefined;
  readonly projectId: string;
  readonly section: ProjectSettingsSection;
}

export function ProjectSettingsPanel({
  embedded = false,
  onSectionChange,
  projectId,
  section,
}: ProjectSettingsPanelProps): ReactElement {
  const controller = useProjectSettings(projectId, section);
  const projectName = controller.projectData?.project.name ?? 'Project';
  const content = (
    <SettingsLayout
      embedded={embedded}
      isOwner={controller.isOwner}
      onSectionChange={onSectionChange}
      projectId={projectId}
      projectName={projectName}
      section={section}
      status={controller.status}
    >
      {section === 'general' ? <GeneralSettings controller={controller} /> : null}
      {section === 'secrets' ? <SecretsSettings controller={controller} /> : null}
      {section === 'integrations' ? <IntegrationsSettings controller={controller} /> : null}
      {section === 'payments' ? <PaymentsSettings controller={controller} /> : null}
      {section === 'members' ? <MembersSettings controller={controller} /> : null}
      {section === 'github' ? <GitHubSettings controller={controller} /> : null}
    </SettingsLayout>
  );

  if (embedded) return content;
  if (controller.session.snapshot.status !== 'ready') return <main>{content}</main>;
  const organizationId = controller.session.snapshot.membership.organization.id;
  return (
    <AppShell
      activePath={`/projects/${projectId}/settings/${section}`}
      invalidOrganization={controller.session.snapshot.invalidOrganization}
      onSignOut={() => controller.session.signOut(organizationId)}
      onSwitchOrganization={controller.session.switchOrganization}
      session={controller.session.snapshot}
    >
      {content}
    </AppShell>
  );
}

export function ProjectSettings({
  projectId,
  section,
}: {
  readonly projectId: string;
  readonly section: ProjectSettingsSection;
}): ReactElement {
  return <ProjectSettingsPanel projectId={projectId} section={section} />;
}
