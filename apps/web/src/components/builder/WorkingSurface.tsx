import type { ReactElement } from 'react';

import type { BuilderMode, ManageSection } from './builder-navigation';
import { ManageSurface } from './ManageSurface';
import { SurfaceTabs, type SurfaceTabsProps } from './SurfaceTabs';
import styles from './builder.module.css';

export interface WorkingSurfaceProps extends SurfaceTabsProps {
  readonly manageSection: ManageSection;
  readonly mode: BuilderMode;
  readonly onManageSectionChange: (section: ManageSection) => void;
  readonly onModeChange: (mode: BuilderMode) => void;
}

export function WorkingSurface({
  manageSection,
  mode,
  onManageSectionChange,
  onModeChange,
  ...surfaceProps
}: WorkingSurfaceProps): ReactElement {
  return (
    <div className={styles.workingSurface}>
      <div aria-label="Builder mode" className={styles.modeSwitcher}>
        {(['preview', 'manage'] as const).map((item) => (
          <button
            aria-pressed={mode === item}
            className={styles.modeButton}
            key={item}
            onClick={() => {
              onModeChange(item);
            }}
            type="button"
          >
            {item === 'preview' ? 'Preview' : 'Manage'}
          </button>
        ))}
      </div>
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
