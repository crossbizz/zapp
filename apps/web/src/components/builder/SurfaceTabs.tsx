'use client';

import type { BuilderPreviewEvent } from '@zapp/api-client';
import { Tabs } from '@zapp/ui';
import { useEffect, useRef, type ReactElement } from 'react';

import type { BuilderRun } from '../../lib/api';
import { PreviewFrame } from '../preview/PreviewFrame';
import type { SelectedPreviewElement } from '../preview/SelectMode';
import { CodeView } from '../code/CodeView';
import { LogView } from '../logs/LogView';
import { TestRuns } from '../tests/TestRuns';

export type SurfaceTab = 'preview' | 'code' | 'logs' | 'tests';

interface SurfaceTabsProps {
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

const tabValues = new Set<SurfaceTab>(['preview', 'code', 'logs', 'tests']);

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

  useEffect(() => {
    if (focusPreviewRequest === 0) return;
    const preview = [
      ...(tabsRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
    ].find((tab) => tab.textContent.trim() === 'Preview');
    preview?.focus();
  }, [focusPreviewRequest]);

  return (
    <div className="zapp-builder-surface-tabs" ref={tabsRef}>
      <Tabs
        defaultValue="preview"
        items={[
          {
            content: (
              <PreviewFrame
                {...(fallbackCommitSha === undefined ? {} : { fallbackCommitSha })}
                onAttachToChat={onAttachPreviewCapture}
                onAttachSelectionToChat={onAttachPreviewSelection}
                onRunCreated={onRunCreated}
                organizationId={organizationId}
                projectId={projectId}
                {...(runId === undefined ? {} : { runId })}
              />
            ),
            label: 'Preview',
            value: 'preview',
          },
          {
            content: <CodeView organizationId={organizationId} projectId={projectId} />,
            label: 'Code',
            value: 'code',
          },
          {
            content: <LogView organizationId={organizationId} projectId={projectId} />,
            label: 'Logs',
            value: 'logs',
          },
          {
            content: <TestRuns onRunCreated={onRunCreated} organizationId={organizationId} projectId={projectId} {...(runId === undefined ? {} : { runId })} />,
            label: 'Tests',
            value: 'tests',
          },
        ]}
        label="Project surfaces"
        onValueChange={(nextValue) => {
          if (tabValues.has(nextValue as SurfaceTab)) onValueChange(nextValue as SurfaceTab);
        }}
        value={value}
      />
    </div>
  );
}
