'use client';

import type { BuilderPreviewEvent } from '@zapp/api-client';
import { useEffect, useRef, type ReactElement } from 'react';

import type { BuilderRun } from '../../lib/api';
import { CodeView } from '../code/CodeView';
import { LogView } from '../logs/LogView';
import { PreviewFrame } from '../preview/PreviewFrame';
import type { SelectedPreviewElement } from '../preview/SelectMode';
import { ProductionHealthView } from '../releases/ProductionHealthView';
import { ReleasesView } from '../releases/ReleasesView';
import { TestRuns } from '../tests/TestRuns';
import type { PreviewSection } from './builder-navigation';
import styles from './builder.module.css';

export type SurfaceTab = PreviewSection;

export interface SurfaceTabsProps {
  readonly fallbackCommitSha?: string;
  readonly focusPreviewRequest: number;
  readonly onAttachPreviewCapture: (file: File, capture: BuilderPreviewEvent) => Promise<boolean>;
  readonly onAttachPreviewSelection: (
    file: File,
    selection: SelectedPreviewElement,
  ) => Promise<boolean>;
  readonly onRunCreated: (run: BuilderRun) => void;
  readonly onValueChange: (value: SurfaceTab) => void;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly value: SurfaceTab;
}

const primaryTabs = [
  ['preview', 'Preview'],
  ['files', 'Files'],
  ['code', 'Code'],
] as const satisfies readonly (readonly [SurfaceTab, string])[];
const moreTabs = [
  ['logs', 'Logs'],
  ['tests', 'Tests'],
  ['releases', 'Releases'],
  ['health', 'Health'],
] as const satisfies readonly (readonly [SurfaceTab, string])[];
const moreValues = new Set<SurfaceTab>(moreTabs.map(([tab]) => tab));

export function SurfaceTabs({
  fallbackCommitSha,
  focusPreviewRequest,
  onAttachPreviewCapture,
  onAttachPreviewSelection,
  onRunCreated,
  onValueChange,
  organizationId,
  projectId,
  runId,
  value,
}: SurfaceTabsProps): ReactElement {
  const tabsRef = useRef<HTMLDivElement>(null);
  const moreActive = moreValues.has(value);

  useEffect(() => {
    if (focusPreviewRequest === 0) return;
    const preview = [
      ...(tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
    ].find((tab) => tab.textContent.trim() === 'Preview');
    preview?.focus();
  }, [focusPreviewRequest]);

  let content: ReactElement;
  switch (value) {
    case 'preview':
      content = (
        <PreviewFrame
          {...(fallbackCommitSha === undefined ? {} : { fallbackCommitSha })}
          onAttachToChat={onAttachPreviewCapture}
          onAttachSelectionToChat={onAttachPreviewSelection}
          onRunCreated={onRunCreated}
          organizationId={organizationId}
          projectId={projectId}
          {...(runId === undefined ? {} : { runId })}
        />
      );
      break;
    case 'files':
      content = (
        <div aria-label="Files view" className={styles.filesView}>
          <p>Browse the current sandbox files and open one to inspect it.</p>
          <CodeView organizationId={organizationId} projectId={projectId} />
        </div>
      );
      break;
    case 'code':
      content = <CodeView organizationId={organizationId} projectId={projectId} />;
      break;
    case 'logs':
      content = <LogView organizationId={organizationId} projectId={projectId} />;
      break;
    case 'tests':
      content = (
        <TestRuns
          onRunCreated={onRunCreated}
          organizationId={organizationId}
          projectId={projectId}
          {...(runId === undefined ? {} : { runId })}
        />
      );
      break;
    case 'releases':
      content = <ReleasesView projectId={projectId} />;
      break;
    case 'health':
      content = <ProductionHealthView projectId={projectId} />;
      break;
  }

  return (
    <div className={`zapp-builder-surface-tabs ${styles.previewSurface ?? ''}`} ref={tabsRef}>
      <div aria-label="Project surfaces" className={styles.surfaceTabs} role="tablist">
        {primaryTabs.map(([tab, label]) => (
          <button
            aria-controls="project-surface-panel"
            aria-selected={value === tab}
            className={styles.surfaceTab}
            key={tab}
            onClick={() => {
              onValueChange(tab);
            }}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
        <button
          aria-controls="project-surface-panel"
          aria-selected={moreActive}
          className={styles.surfaceTab}
          onClick={() => {
            onValueChange(moreActive ? value : 'logs');
          }}
          role="tab"
          type="button"
        >
          More
        </button>
      </div>
      {moreActive ? (
        <div aria-label="More project views" className={styles.moreTabs} role="tablist">
          {moreTabs.map(([tab, label]) => (
            <button
              aria-controls="project-surface-panel"
              aria-selected={value === tab}
              className={styles.moreTab}
              key={tab}
              onClick={() => {
                onValueChange(tab);
              }}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        aria-label={`${value.slice(0, 1).toUpperCase()}${value.slice(1)} view`}
        className={styles.surfacePanel}
        id="project-surface-panel"
        role="tabpanel"
      >
        {content}
      </div>
    </div>
  );
}
