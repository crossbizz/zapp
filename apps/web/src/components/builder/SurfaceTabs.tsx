'use client';

import type { BuilderPreviewEvent, RunEvent } from '@zapp/api-client';
import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';

import type { BuilderRun } from '../../lib/api';
import { CodeView } from '../code/CodeView';
import { PreviewFrame } from '../preview/PreviewFrame';
import type { SelectedPreviewElement } from '../preview/SelectMode';
import type { PreviewSection } from './builder-navigation';
import { MoreView } from './MoreView';
import styles from './builder.module.css';

export type SurfaceTab = PreviewSection;

export interface SurfaceTabsProps {
  readonly branchId: string;
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
  readonly runEvents: readonly RunEvent[];
  readonly runStatus?: BuilderRun['status'];
  readonly value: SurfaceTab;
}

const primaryTabs = [
  ['preview', 'Preview'],
  ['files', 'Files'],
  ['code', 'Code'],
] as const satisfies readonly (readonly [SurfaceTab, string])[];
const moreValues = new Set<SurfaceTab>(['logs', 'tests', 'releases', 'health']);

function SurfaceIcon({
  tab,
}: {
  readonly tab: 'code' | 'files' | 'more' | 'preview';
}): ReactElement {
  switch (tab) {
    case 'preview':
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5C9.6 18.2 8.4 15.4 8.4 12S9.6 5.8 12 3.5Z" />
        </svg>
      );
    case 'files':
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M6 3.5h8l4 4V20H6V3.5Z" />
          <path d="M14 3.5V8h4" />
        </svg>
      );
    case 'code':
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M14 4l-4 16" />
        </svg>
      );
    case 'more':
      return (
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="m4 7 8-4 8 4-8 4-8-4ZM4 12l8 4 8-4M4 17l8 4 8-4" />
        </svg>
      );
  }
}

export function SurfaceTabs({
  branchId,
  fallbackCommitSha,
  focusPreviewRequest,
  onAttachPreviewCapture,
  onAttachPreviewSelection,
  onRunCreated,
  onValueChange,
  organizationId,
  projectId,
  runId,
  runEvents,
  runStatus,
  value,
}: SurfaceTabsProps): ReactElement {
  const tabsRef = useRef<HTMLDivElement>(null);
  const moreActive = moreValues.has(value);

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [
      ...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        ':scope > [role="tab"]',
      ) ?? []),
    ];
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0 || tabs.length === 0) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    next?.focus();
    next?.click();
  };

  useEffect(() => {
    if (focusPreviewRequest === 0) return;
    const preview = [
      ...(tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
    ].find((tab) => tab.getAttribute('aria-label') === 'Preview');
    preview?.focus();
  }, [focusPreviewRequest]);

  let content: ReactElement;
  switch (value) {
    case 'preview':
      content = (
        <PreviewFrame
          branchId={branchId}
          events={runEvents}
          {...(fallbackCommitSha === undefined ? {} : { fallbackCommitSha })}
          onAttachToChat={onAttachPreviewCapture}
          onAttachSelectionToChat={onAttachPreviewSelection}
          onRunCreated={onRunCreated}
          organizationId={organizationId}
          projectId={projectId}
          {...(runStatus === undefined ? {} : { runStatus })}
        />
      );
      break;
    case 'files':
      content = (
        <CodeView
          branchId={branchId}
          organizationId={organizationId}
          projectId={projectId}
          view="files"
        />
      );
      break;
    case 'code':
      content = (
        <CodeView
          branchId={branchId}
          organizationId={organizationId}
          projectId={projectId}
          view="changes"
        />
      );
      break;
    case 'logs':
    case 'tests':
    case 'releases':
    case 'health':
      content = (
        <MoreView
          activeSurface={value}
          events={runEvents}
          onRunCreated={onRunCreated}
          onSurfaceChange={onValueChange}
          organizationId={organizationId}
          projectId={projectId}
          {...(runId === undefined ? {} : { runId })}
          {...(runStatus === undefined ? {} : { runStatus })}
        />
      );
      break;
  }

  return (
    <div className={`zapp-builder-surface-tabs ${styles.previewSurface ?? ''}`} ref={tabsRef}>
      <div aria-label="Project surfaces" className={styles.surfaceTabs} role="tablist">
        {primaryTabs.map(([tab, label]) => (
          <button
            aria-controls="project-surface-panel"
            aria-label={label}
            aria-selected={value === tab}
            className={styles.surfaceTab}
            data-compact-tab={tab === 'preview' ? 'labelled' : 'icon'}
            key={tab}
            onClick={() => {
              onValueChange(tab);
            }}
            onKeyDown={moveTabFocus}
            role="tab"
            tabIndex={value === tab ? 0 : -1}
            title={label}
            type="button"
          >
            <span className={styles.surfaceTabIcon}>
              <SurfaceIcon tab={tab} />
            </span>
            {tab === 'preview' ? <span>{label}</span> : null}
          </button>
        ))}
        <button
          aria-controls="project-surface-panel"
          aria-label="More"
          aria-selected={moreActive}
          className={styles.surfaceTab}
          data-compact-tab={moreActive ? 'labelled' : 'icon'}
          onClick={() => {
            onValueChange(moreActive ? value : 'health');
          }}
          onKeyDown={moveTabFocus}
          role="tab"
          tabIndex={moreActive ? 0 : -1}
          title="More"
          type="button"
        >
          <span className={styles.surfaceTabIcon}>
            <SurfaceIcon tab="more" />
          </span>
          {moreActive ? <span>More</span> : null}
        </button>
      </div>
      <div
        aria-label={`${value.slice(0, 1).toUpperCase()}${value.slice(1)} view`}
        className={`${styles.surfacePanel ?? ''} ${moreActive ? (styles.moreSurfacePanel ?? '') : ''}`}
        id="project-surface-panel"
        role="tabpanel"
      >
        {content}
      </div>
    </div>
  );
}
