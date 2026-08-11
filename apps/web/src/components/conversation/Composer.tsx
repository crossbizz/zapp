'use client';

import type { BuilderPreviewEvent } from '@zapp/api-client';
import { Button, IconButton } from '@zapp/ui';
import Link from 'next/link';
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ReactElement,
  type SyntheticEvent,
} from 'react';

import type { CreateRunInput } from '../../lib/api';

const maximumImages = 10;
const maximumImageBytes = 8 * 1024 * 1024;
const supportedImageTypes = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const modes = [
  { description: 'Let zapp choose from your message.', label: 'Auto (recommended)', value: 'auto' },
  { description: 'Get guidance without changing code.', label: 'Ask', value: 'ask' },
  { description: 'Explore with a lightweight first pass.', label: 'Prototype', value: 'prototype' },
  { description: 'Build a production-oriented change.', label: 'Build', value: 'build' },
  { description: 'Repair a specific problem.', label: 'Fix', value: 'fix' },
  { description: 'Run the full workflow.', label: 'Autonomous', value: 'autonomous' },
] as const;

export type ConversationMode = 'auto' | CreateRunInput['mode'];

export interface ConversationSubmission {
  readonly branchId?: string;
  readonly budget?: CreateRunInput['budget'];
  readonly content: string;
  readonly files: readonly File[];
  readonly mode: ConversationMode;
  readonly model?: string;
}

export interface ConversationImageInput {
  readonly capture?: BuilderPreviewEvent;
  readonly file: File;
  readonly id: string;
  readonly onConsumed?: (accepted: boolean) => void;
}

export interface ConversationComposerProps {
  readonly active: boolean;
  readonly allowedModels: readonly string[];
  readonly branches: readonly { readonly id: string; readonly name: string }[];
  readonly incomingImages?: readonly ConversationImageInput[];
  readonly onStop: () => Promise<void>;
  readonly onSubmit: (submission: ConversationSubmission) => Promise<boolean>;
  readonly projectId: string;
  readonly sending: boolean;
  readonly stopping: boolean;
}

interface ComposerSettings {
  readonly branchId?: string;
  readonly budget?: number;
  readonly mode: ConversationMode;
  readonly model?: string;
}

interface SelectedImage {
  readonly capture?: BuilderPreviewEvent;
  readonly file: File;
  readonly id: string;
}

function captureDescription(event: BuilderPreviewEvent): string {
  switch (event.type) {
    case 'console':
    case 'runtime_error':
      return event.payload.message;
    case 'network':
      return `${event.payload.method} ${String(event.payload.status)} ${event.payload.url}`;
    case 'route_change':
      return event.payload.url;
  }
}

function settingsKey(projectId: string): string {
  return `zapp:conversation:settings:${projectId}`;
}

function readSettings(projectId: string, allowedModels: readonly string[]): ComposerSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(settingsKey(projectId)) ?? '{}') as {
      branchId?: unknown;
      budget?: unknown;
      mode?: unknown;
      model?: unknown;
    };
    const mode = modes.some((candidate) => candidate.value === parsed.mode)
      ? (parsed.mode as ConversationMode)
      : 'auto';
    const model =
      typeof parsed.model === 'string' && allowedModels.includes(parsed.model)
        ? parsed.model
        : undefined;
    const branchId = typeof parsed.branchId === 'string' ? parsed.branchId : undefined;
    const budget =
      typeof parsed.budget === 'number' &&
      Number.isInteger(parsed.budget) &&
      parsed.budget > 0 &&
      parsed.budget <= 1_000_000
        ? parsed.budget
        : undefined;
    return {
      ...(branchId === undefined ? {} : { branchId }),
      ...(budget === undefined ? {} : { budget }),
      mode,
      ...(model === undefined ? {} : { model }),
    };
  } catch {
    return { mode: 'auto' };
  }
}

function persistSettings(projectId: string, settings: ComposerSettings): void {
  try {
    localStorage.setItem(settingsKey(projectId), JSON.stringify(settings));
  } catch {
    // The selection remains available for the current page when storage is unavailable.
  }
}

export function Composer({
  active,
  allowedModels,
  branches,
  incomingImages = [],
  onStop,
  onSubmit,
  projectId,
  sending,
  stopping,
}: ConversationComposerProps): ReactElement {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const consumedIncomingImagesRef = useRef(new Set<string>());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [content, setContent] = useState('');
  const [imageError, setImageError] = useState<string>();
  const [images, setImages] = useState<readonly SelectedImage[]>([]);
  const imagesRef = useRef<readonly SelectedImage[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [settings, setSettings] = useState<ComposerSettings>({ mode: 'auto' });
  const [settingsProjectId, setSettingsProjectId] = useState<string>();

  useEffect(() => {
    const restored = readSettings(projectId, allowedModels);
    const availableBranch = branches.some((branch) => branch.id === restored.branchId);
    const { branchId: restoredBranchId, ...settingsWithoutBranch } = restored;
    setSettings({
      ...settingsWithoutBranch,
      ...(availableBranch && restoredBranchId !== undefined
        ? { branchId: restoredBranchId }
        : branches[0] === undefined
          ? {}
          : { branchId: branches[0].id }),
    });
    setSettingsProjectId(projectId);
  }, [allowedModels, branches, projectId]);

  useEffect(() => {
    if (settingsProjectId !== projectId) return;
    persistSettings(projectId, settings);
  }, [projectId, settings, settingsProjectId]);

  const updateSettings = (next: ComposerSettings): void => {
    setSettings(next);
  };

  const addImages = (
    inputs: readonly Pick<ConversationImageInput, 'capture' | 'file'>[],
  ): readonly boolean[] => {
    let available = maximumImages - imagesRef.current.length;
    let exceededCapacity = false;
    let unsupported = false;
    let invalidSize = false;
    const results: boolean[] = [];
    const accepted: SelectedImage[] = [];
    for (const { capture, file } of inputs) {
      if (!supportedImageTypes.has(file.type)) {
        unsupported = true;
        results.push(false);
        continue;
      }
      if (file.size <= 0 || file.size > maximumImageBytes) {
        invalidSize = true;
        results.push(false);
        continue;
      }
      if (available <= 0) {
        exceededCapacity = true;
        results.push(false);
        continue;
      }
      available -= 1;
      results.push(true);
      accepted.push({
        ...(capture === undefined ? {} : { capture }),
        file,
        id: crypto.randomUUID(),
      });
    }
    const nextImages = [...imagesRef.current, ...accepted];
    imagesRef.current = nextImages;
    setImages(nextImages);
    if (exceededCapacity) {
      setImageError('You can attach up to 10 images.');
    } else if (unsupported) {
      setImageError('Use PNG, JPEG, WebP, or GIF images.');
    } else if (invalidSize) {
      setImageError('Each image must be between 1 byte and 8 MiB.');
    } else {
      setImageError(undefined);
    }
    return results;
  };

  useEffect(() => {
    const fresh = incomingImages.filter(
      (image) => !consumedIncomingImagesRef.current.has(image.id),
    );
    if (fresh.length === 0) return;
    const results = addImages(fresh);
    fresh.forEach((image, index) => {
      consumedIncomingImagesRef.current.add(image.id);
      image.onConsumed?.(results[index] === true);
    });
    if (results.some(Boolean)) messageInputRef.current?.focus();
  }, [incomingImages]);

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    addImages(Array.from(event.currentTarget.files ?? [], (file) => ({ file })));
    event.currentTarget.value = '';
  };

  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length === 0) return;
    event.preventDefault();
    addImages(files.map((file) => ({ file })));
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    const trimmed = content.trim();
    if (trimmed.length === 0 || sending) return;
    const sent = await onSubmit({
      ...(settings.branchId === undefined ? {} : { branchId: settings.branchId }),
      ...(settings.budget === undefined ? {} : { budget: { maxCredits: settings.budget } }),
      content: trimmed,
      files: images.map(({ file }) => file),
      mode: settings.mode,
      ...(settings.model === undefined ? {} : { model: settings.model }),
    });
    if (!sent) return;
    setContent('');
    imagesRef.current = [];
    setImages([]);
    setImageError(undefined);
  };

  return (
    <form className="zapp-conversation-composer" onSubmit={(event) => void submit(event)}>
      <div aria-label="Attached images" className="zapp-conversation-images">
        {images.map((image) => (
          <span className="zapp-conversation-image-chip" key={image.id}>
            {image.file.name}
            {image.capture === undefined ? null : ` · ${captureDescription(image.capture)}`}
            <button
              aria-label={`Remove ${image.file.name}`}
              onClick={() => {
                const nextImages = imagesRef.current.filter(
                  (candidate) => candidate.id !== image.id,
                );
                imagesRef.current = nextImages;
                setImages(nextImages);
                setImageError(undefined);
              }}
              type="button"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {imageError === undefined ? null : <p role="alert">{imageError}</p>}
      <label className="zapp-sr-only" htmlFor="conversation-message">
        Message the agent
      </label>
      <textarea
        id="conversation-message"
        maxLength={20_000}
        onChange={(event) => {
          setContent(event.currentTarget.value);
        }}
        onPaste={pasteImages}
        placeholder="Ask for a change or tell the agent what to do next…"
        ref={messageInputRef}
        rows={3}
        value={content}
      />
      <div className="zapp-conversation-composer-actions">
        <IconButton
          aria-expanded={menuOpen}
          label="Add attachment or controls"
          onClick={() => {
            setMenuOpen((open) => !open);
            setAdvancedOpen(false);
            setModeMenuOpen(false);
          }}
        >
          <span aria-hidden="true">+</span>
        </IconButton>
        <span className="zapp-conversation-composer-spacer" />
        {active ? (
          <Button
            disabled={stopping}
            onClick={() => void onStop()}
            type="button"
            variant="secondary"
          >
            {stopping ? 'Stopping…' : 'Stop run'}
          </Button>
        ) : null}
        <Button disabled={content.trim().length === 0 || sending} type="submit">
          {sending ? 'Sending…' : 'Send message'}
        </Button>
      </div>
      {menuOpen ? (
        <div aria-label="Attachment and run controls" className="zapp-conversation-menu">
          <button onClick={() => fileInputRef.current?.click()} type="button">
            Upload file
          </button>
          <input
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="Upload file"
            hidden
            multiple
            onChange={chooseFiles}
            ref={fileInputRef}
            type="file"
          />
          <Link href="/projects?import=github">Import from GitHub</Link>
          <button
            onClick={() => {
              setModeMenuOpen((open) => !open);
              setAdvancedOpen(false);
            }}
            type="button"
          >
            {settings.mode === 'auto'
              ? 'Auto'
              : modes.find((mode) => mode.value === settings.mode)?.label}{' '}
            ▸
          </button>
          <button
            onClick={() => {
              setAdvancedOpen((open) => !open);
              setModeMenuOpen(false);
            }}
            type="button"
          >
            Advanced controls
          </button>
          {modeMenuOpen ? (
            <fieldset>
              <legend>Mode and model</legend>
              {modes.map((mode) => (
                <label key={mode.value}>
                  <input
                    checked={settings.mode === mode.value}
                    name="conversation-mode"
                    onChange={() => {
                      updateSettings({ ...settings, mode: mode.value });
                    }}
                    type="radio"
                  />
                  <span>
                    <strong>{mode.label}</strong>
                    <small>{mode.description}</small>
                  </span>
                </label>
              ))}
              <label>
                Model
                <select
                  onChange={(event) => {
                    const model = event.currentTarget.value || undefined;
                    if (model === undefined) {
                      const { model: removedModel, ...withoutModel } = settings;
                      void removedModel;
                      updateSettings(withoutModel);
                    } else {
                      updateSettings({ ...settings, model });
                    }
                  }}
                  value={settings.model ?? ''}
                >
                  <option value="">Auto (organization policy)</option>
                  {allowedModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          ) : null}
          {advancedOpen ? (
            <fieldset>
              <legend>Advanced controls</legend>
              <label>
                Run budget cap
                <input
                  max={1_000_000}
                  min={1}
                  onChange={(event) => {
                    const parsed = Number(event.currentTarget.value);
                    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000_000) {
                      updateSettings({ ...settings, budget: parsed });
                    } else {
                      const { budget: removedBudget, ...withoutBudget } = settings;
                      void removedBudget;
                      updateSettings(withoutBudget);
                    }
                  }}
                  type="number"
                  value={settings.budget ?? ''}
                />
              </label>
              <label>
                Target branch
                <select
                  onChange={(event) => {
                    const branchId = event.currentTarget.value || undefined;
                    if (branchId === undefined) {
                      const { branchId: removedBranch, ...withoutBranch } = settings;
                      void removedBranch;
                      updateSettings(withoutBranch);
                    } else {
                      updateSettings({ ...settings, branchId });
                    }
                  }}
                  value={settings.branchId ?? ''}
                >
                  <option value="">Default branch</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
