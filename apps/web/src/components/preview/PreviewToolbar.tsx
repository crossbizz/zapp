'use client';

import { Button, EnvBadge, IconButton } from '@zapp/ui';
import { type ReactElement, type ReactNode } from 'react';

export type PreviewDevice = 'desktop' | 'mobile' | 'tablet';

interface PreviewToolbarProps {
  readonly children?: ReactNode;
  readonly device: PreviewDevice;
  readonly onDeviceChange: (device: PreviewDevice) => void;
  readonly onOpen: () => void;
  readonly onRefresh: () => void;
  readonly onShare: () => void;
  readonly path: string;
  readonly shareUrl?: string;
  readonly sharing: boolean;
}

const devices: readonly { readonly label: string; readonly value: PreviewDevice }[] = [
  { label: 'Desktop', value: 'desktop' },
  { label: 'Tablet', value: 'tablet' },
  { label: 'Mobile', value: 'mobile' },
];

export function PreviewToolbar({
  children,
  device,
  onDeviceChange,
  onOpen,
  onRefresh,
  onShare,
  path,
  shareUrl,
  sharing,
}: PreviewToolbarProps): ReactElement {
  return (
    <div aria-label="Preview controls" className="zapp-preview-toolbar" role="toolbar">
      <EnvBadge environment="preview" />
      <div aria-label="Preview path" className="zapp-preview-path">
        {path}
      </div>
      <div aria-label="Preview device size" className="zapp-preview-devices" role="group">
        {devices.map((candidate) => (
          <button
            aria-pressed={device === candidate.value}
            key={candidate.value}
            onClick={() => {
              onDeviceChange(candidate.value);
            }}
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </div>
      {children}
      <div className="zapp-preview-toolbar-actions">
        <IconButton label="Open in new tab" onClick={onOpen}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M14 5h5v5M19 5l-8 8M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
          </svg>
        </IconButton>
        <IconButton label="Refresh" onClick={onRefresh}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.5-2.6L20 11M4 13l2.4 4.6A7 7 0 0 0 17.9 15" />
          </svg>
        </IconButton>
        <Button disabled={sharing} onClick={onShare} variant="secondary">
          {sharing ? 'Creating link…' : 'Share link'}
        </Button>
      </div>
      {shareUrl === undefined ? null : (
        <div className="zapp-preview-share-result" role="status">
          <label>
            Share link
            <input readOnly value={shareUrl} />
          </label>
        </div>
      )}
    </div>
  );
}
