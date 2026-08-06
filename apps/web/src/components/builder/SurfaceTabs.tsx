'use client';

import { EmptyState, Tabs } from '@zapp/ui';
import { useEffect, useRef, type ReactElement } from 'react';

export type SurfaceTab = 'preview' | 'code' | 'logs' | 'tests';

interface SurfaceTabsProps {
  readonly focusPreviewRequest: number;
  readonly onValueChange: (value: SurfaceTab) => void;
  readonly value: SurfaceTab;
}

const tabValues = new Set<SurfaceTab>(['preview', 'code', 'logs', 'tests']);

export function SurfaceTabs({
  focusPreviewRequest,
  onValueChange,
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
              <EmptyState
                description="No preview has been created for this project."
                title="Preview unavailable"
              />
            ),
            label: 'Preview',
            value: 'preview',
          },
          {
            content: (
              <EmptyState
                description="Code will appear after the first build starts."
                title="No generated code yet"
              />
            ),
            label: 'Code',
            value: 'code',
          },
          {
            content: (
              <EmptyState
                description="Runtime output will appear after work begins."
                title="No logs yet"
              />
            ),
            label: 'Logs',
            value: 'logs',
          },
          {
            content: (
              <EmptyState
                description="Verification results will appear after tests run."
                title="No test results yet"
              />
            ),
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
