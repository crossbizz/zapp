'use client';

import { Button } from '@zapp/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

const maximumComponentHintChars = 256;
const maximumRoleChars = 64;
const maximumSelectorChars = 2_048;
const maximumTextChars = 4_096;

export interface SelectedPreviewElement {
  readonly boundingBox: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly componentHint: string;
  readonly path: string;
  readonly role: string;
  readonly selector: string;
  readonly text: string;
}

interface SelectModeProps {
  readonly disabled: boolean;
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  readonly onSelected: (selection: Omit<SelectedPreviewElement, 'path'>) => void;
  readonly previewUrl?: string;
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maximumLength ? value : undefined;
}

function finiteCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function selectionFromMessage(value: unknown): Omit<SelectedPreviewElement, 'path'> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const message = value as Readonly<Record<string, unknown>>;
  if (message['type'] !== 'zapp:element-selected') return undefined;
  const payload = message['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const fields = payload as Readonly<Record<string, unknown>>;
  const selector = boundedString(fields['selector'], maximumSelectorChars);
  const role = boundedString(fields['computedRole'], maximumRoleChars);
  const text = boundedString(fields['text'], maximumTextChars);
  const componentHint = boundedString(fields['componentHint'], maximumComponentHintChars);
  const box = fields['boundingBox'];
  if (typeof box !== 'object' || box === null || Array.isArray(box)) return undefined;
  const coordinates = box as Readonly<Record<string, unknown>>;
  const x = finiteCoordinate(coordinates['x']);
  const y = finiteCoordinate(coordinates['y']);
  const width = finiteCoordinate(coordinates['width']);
  const height = finiteCoordinate(coordinates['height']);
  if (
    selector === undefined ||
    role === undefined ||
    text === undefined ||
    componentHint === undefined ||
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  )
    return undefined;
  return { boundingBox: { height, width, x, y }, componentHint, role, selector, text };
}

function previewOrigin(previewUrl: string | undefined): string | undefined {
  if (previewUrl === undefined) return undefined;
  try {
    return new URL(previewUrl).origin;
  } catch {
    return undefined;
  }
}

export function SelectMode({
  disabled,
  iframeRef,
  onSelected,
  previewUrl,
}: SelectModeProps): React.ReactElement {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('Selection mode is off.');
  const enabledRef = useRef(false);
  const origin = useMemo(() => previewOrigin(previewUrl), [previewUrl]);

  const postSelectionMode = useCallback(
    (nextEnabled: boolean): boolean => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (iframeWindow === null || iframeWindow === undefined || origin === undefined) return false;
      iframeWindow.postMessage({ enabled: nextEnabled, type: 'zapp:selection-mode' }, origin);
      return true;
    },
    [iframeRef, origin],
  );

  useEffect(() => {
    enabledRef.current = false;
    setEnabled(false);
    setStatus('Selection mode is off.');
  }, [origin]);

  useEffect(() => {
    if (!disabled || !enabledRef.current) return;
    postSelectionMode(false);
    enabledRef.current = false;
    setEnabled(false);
    setStatus('Selection mode is off.');
  }, [disabled, postSelectionMode]);

  useEffect(() => {
    const receiveSelection = (event: MessageEvent<unknown>): void => {
      if (origin === undefined || event.origin !== origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (disabled || !enabledRef.current) return;
      const selection = selectionFromMessage(event.data);
      if (selection === undefined) return;
      postSelectionMode(false);
      enabledRef.current = false;
      setEnabled(false);
      setStatus('Element selected. Capturing its screenshot.');
      onSelected(selection);
    };
    window.addEventListener('message', receiveSelection);
    return () => {
      window.removeEventListener('message', receiveSelection);
    };
  }, [disabled, iframeRef, onSelected, origin, postSelectionMode]);

  return (
    <div className="zapp-preview-select-mode">
      <Button
        aria-pressed={enabled}
        disabled={disabled || origin === undefined}
        onClick={() => {
          const nextEnabled = !enabled;
          if (!postSelectionMode(nextEnabled)) {
            setStatus('The authenticated preview is not ready for element selection.');
            return;
          }
          enabledRef.current = nextEnabled;
          setEnabled(nextEnabled);
          setStatus(nextEnabled ? 'Selection mode is on. Choose an element in the preview.' : 'Selection mode is off.');
        }}
        variant={enabled ? 'primary' : 'secondary'}
      >
        Select element
      </Button>
      <p aria-live="polite" className="zapp-sr-only">
        {status}
      </p>
    </div>
  );
}
