import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

import type { ProjectSettingsSection } from './settings-types';
import styles from './settings.module.css';

const sections = [
  ['general', 'General'],
  ['secrets', 'Secrets'],
  ['integrations', 'Integrations'],
  ['payments', 'Payments'],
  ['members', 'Members'],
  ['github', 'GitHub'],
] as const satisfies readonly (readonly [ProjectSettingsSection, string])[];

export interface SettingsLayoutProps {
  readonly children: ReactNode;
  readonly embedded: boolean;
  readonly isOwner: boolean;
  readonly onSectionChange?: ((section: ProjectSettingsSection) => void) | undefined;
  readonly projectId: string;
  readonly projectName: string;
  readonly section: ProjectSettingsSection;
  readonly status: string;
}

export function SettingsLayout({
  children,
  embedded,
  isOwner,
  onSectionChange,
  projectId,
  projectName,
  section,
  status,
}: SettingsLayoutProps): ReactElement {
  return (
    <div className={`${styles.settings ?? ''} ${embedded ? styles.embedded ?? '' : ''}`}>
      <header className={styles.settingsHeader}>
        {embedded ? null : <Link href={`/projects/${projectId}`}>← Back to project</Link>}
        <p className={styles.eyebrow}>Project settings</p>
        <h1>{projectName} settings</h1>
      </header>
      <div className={styles.settingsBody}>
        <nav aria-label="Project settings" className={styles.settingsNavigation}>
          {sections
            .filter(([item]) => item !== 'members' || isOwner)
            .map(([item, label]) => embedded ? (
              <button
                aria-current={section === item ? 'page' : undefined}
                key={item}
                onClick={() => onSectionChange?.(item)}
                type="button"
              >
                {label}
              </button>
            ) : (
              <Link
                aria-current={section === item ? 'page' : undefined}
                href={`/projects/${projectId}/settings/${item}`}
                key={item}
              >
                {label}
              </Link>
            ))}
        </nav>
        <div className={styles.settingsContent}>
          <p aria-live="polite" className={styles.status}>{status}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
