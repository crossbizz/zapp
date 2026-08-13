'use client';

import { Button, EnvBadge } from '@zapp/ui';
import { type ReactElement } from 'react';

export type PreviewDevice = 'desktop' | 'mobile' | 'tablet';

interface PreviewToolbarProps {
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
    <header className="zapp-preview-toolbar">
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
      <div className="zapp-preview-toolbar-actions">
        <Button onClick={onOpen} variant="ghost">
          Open in new tab
        </Button>
        <Button onClick={onRefresh} variant="ghost">
          Refresh
        </Button>
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
    </header>
  );
}
