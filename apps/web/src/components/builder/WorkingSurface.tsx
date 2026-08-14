import type { ReactElement } from 'react';

import type { BuilderMode, ManageSection } from './builder-navigation';
import { ManageSurface } from './ManageSurface';
import { SurfaceTabs, type SurfaceTabsProps } from './SurfaceTabs';
import styles from './builder.module.css';

export interface WorkingSurfaceProps extends SurfaceTabsProps {
  readonly manageSection: ManageSection;
  readonly mode: BuilderMode;
  readonly onManageSectionChange: (section: ManageSection) => void;
}

export function WorkingSurface({
  manageSection,
  mode,
  onManageSectionChange,
  ...surfaceProps
}: WorkingSurfaceProps): ReactElement {
  return (
    <div className={styles.workingSurface}>
      {mode === 'preview' ? (
        <SurfaceTabs {...surfaceProps} />
      ) : (
        <ManageSurface
          onSectionChange={onManageSectionChange}
          projectId={surfaceProps.projectId}
          section={manageSection}
        />
      )}
    </div>
  );
}
