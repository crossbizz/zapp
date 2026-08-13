import type { ReactElement } from 'react';

import { ProjectSettingsPanel } from '../settings/ProjectSettings';
import type { ManageSection } from './builder-navigation';

export interface ManageSurfaceProps {
  readonly onSectionChange: (section: ManageSection) => void;
  readonly projectId: string;
  readonly section: ManageSection;
}

export function ManageSurface({
  onSectionChange,
  projectId,
  section,
}: ManageSurfaceProps): ReactElement {
  return (
    <ProjectSettingsPanel
      embedded
      onSectionChange={onSectionChange}
      projectId={projectId}
      section={section}
    />
  );
}
