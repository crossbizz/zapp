'use client';

import { Button, IconButton } from '@zapp/ui';
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

function DeviceIcon({ device }: { readonly device: PreviewDevice }): ReactElement {
  if (device === 'desktop') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect height="13" rx="1.8" width="18" x="3" y="4" />
        <path d="M9 21h6M12 17v4" />
      </svg>
    );
  }
  if (device === 'tablet') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect height="18" rx="2" width="14" x="5" y="3" />
        <path d="M11 18h2" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect height="20" rx="2" width="11" x="6.5" y="2" />
      <path d="M11 19h2" />
    </svg>
  );
}

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
  const pageLabel = path === '/' ? 'Homepage' : path;

  return (
    <div aria-label="Preview controls" className="zapp-preview-toolbar" role="toolbar">
      <div aria-label="Preview device size" className="zapp-preview-devices" role="group">
        {devices.map((candidate) => (
          <button
            aria-label={`${candidate.label} view`}
            aria-pressed={device === candidate.value}
            key={candidate.value}
            onClick={() => {
              onDeviceChange(candidate.value);
            }}
            title={`${candidate.label} view`}
            type="button"
          >
            <DeviceIcon device={candidate.value} />
          </button>
        ))}
      </div>
      <IconButton label="Refresh" onClick={onRefresh} title="Refresh">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.5-2.6L20 11M4 13l2.4 4.6A7 7 0 0 0 17.9 15" />
        </svg>
      </IconButton>
      <div aria-label={`Preview path ${path}`} className="zapp-preview-path" title={path}>
        <span>{pageLabel}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <path d="m5 6 3 3 3-3" />
        </svg>
      </div>
      <IconButton label="Open in new tab" onClick={onOpen} title="Open in new tab">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M14 5h5v5M19 5l-8 8M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
        </svg>
      </IconButton>
      <div className="zapp-preview-toolbar-actions">
        {children}
        <Button aria-label="Share link" disabled={sharing} onClick={onShare} variant="secondary">
          {sharing ? 'Sharing…' : 'Share'}
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
