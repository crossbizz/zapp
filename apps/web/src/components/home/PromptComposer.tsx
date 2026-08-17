'use client';

import { ErrorState, IconButton } from '@zapp/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useRef,
  useLayoutEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ReactElement,
  type SyntheticEvent,
} from 'react';

import {
  createControlPlaneClient,
  type CreateRunInput,
  type CreateRunMessageInput,
} from '../../lib/api';
import { captureProjectCreated } from '../../lib/activation';
import { selectImageFiles } from '../../lib/image-attachments';
import { deriveProjectTitle } from '../../lib/project-title';
import { rememberFirstPrompt } from '../../lib/prompt-handoff';
import styles from './home.module.css';

type RunMode = Exclude<CreateRunInput['mode'], 'fix'>;
type ComposerMode = 'auto' | RunMode;

interface ModeOption {
  readonly description: string;
  readonly label: string;
  readonly value: ComposerMode;
}

const MODE_OPTIONS = [
  { description: 'Let zapp choose from your prompt.', label: 'Auto (recommended)', value: 'auto' },
  { description: 'Get guidance without changing code.', label: 'Ask', value: 'ask' },
  {
    description: 'Explore an idea with a lightweight first pass.',
    label: 'Prototype',
    value: 'prototype',
  },
  { description: 'Build a production-oriented implementation.', label: 'Build', value: 'build' },
  {
    description: 'Run the full workflow with minimal intervention.',
    label: 'Autonomous',
    value: 'autonomous',
  },
] as const satisfies readonly ModeOption[];

const EXPLORATORY_PATTERN =
  /\b(?:idea|explore|experiment|prototype|try)\b|\bwhat\s+if\b|\bnot\s+sure\b/u;
const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u;

type AppType = NonNullable<CreateRunInput['appType']>;

interface SpeechRecognitionResultLike {
  readonly results: {
    readonly [index: number]:
      | {
          readonly [index: number]: { readonly transcript: string } | undefined;
        }
      | undefined;
  };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: SpeechRecognitionResultLike) => void) | null;
  start(): void;
}

interface SpeechWindow extends Window {
  readonly SpeechRecognition?: new () => SpeechRecognitionLike;
  readonly webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}

function recommendedMode(prompt: string): RunMode {
  const normalized = prompt.toLocaleLowerCase('en-US');
  return EXPLORATORY_PATTERN.test(normalized) ? 'prototype' : 'build';
}

function renderedTextareaRows(textarea: HTMLTextAreaElement): number {
  textarea.rows = 3;
  const style = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const verticalPadding =
    Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0 || !Number.isFinite(verticalPadding))
    return 3;
  const renderedRows = Math.ceil((textarea.scrollHeight - verticalPadding) / lineHeight);
  const clampedRows = Math.min(10, Math.max(3, renderedRows));
  textarea.rows = clampedRows;
  return clampedRows;
}

interface PendingCreation {
  readonly attachmentKeys: readonly string[];
  readonly attachmentMessageKey: string;
  readonly appType: AppType;
  readonly files: readonly File[];
  readonly model?: CreateRunInput['model'];
  readonly projectBody: Parameters<ReturnType<typeof createControlPlaneClient>['createProject']>[0];
  readonly projectIdempotencyKey: string;
  readonly prompt: string;
  readonly requestedBranch: string;
  readonly runBudget?: CreateRunInput['budget'];
  readonly runIdempotencyKey: string;
  readonly runMode: RunMode;
  readonly uploads: Map<number, NonNullable<CreateRunMessageInput['attachments']>[number]>;
  runBody?: CreateRunInput;
}

interface SelectedImage {
  readonly file: File;
  readonly id: string;
}

export interface PromptComposerProps {
  readonly allowedModels: readonly string[];
  readonly appType: AppType;
  readonly githubImportEnabled?: boolean;
  readonly organizationId: string;
  readonly onPromptChange: (value: string) => void;
  readonly onGitHubImport?: () => void;
  readonly prompt: string;
  readonly voiceInputEnabled: boolean;
}

export function PromptComposer({
  allowedModels,
  appType,
  githubImportEnabled = true,
  organizationId,
  onPromptChange,
  onGitHubImport,
  prompt,
  voiceInputEnabled,
}: PromptComposerProps): ReactElement {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCreationRef = useRef<PendingCreation | undefined>(undefined);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [mode, setMode] = useState<ComposerMode>('auto');
  const [selectedModel, setSelectedModel] = useState<CreateRunInput['model']>();
  const [budget, setBudget] = useState('');
  const [targetBranch, setTargetBranch] = useState('main');
  const [images, setImages] = useState<readonly SelectedImage[]>([]);
  const imagesRef = useRef<readonly SelectedImage[]>([]);
  const [imageError, setImageError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [voiceError, setVoiceError] = useState(false);
  const [textareaRowCount, setTextareaRowCount] = useState(3);
  const trimmedPrompt = prompt.trim();
  const canSubmit = trimmedPrompt.length >= 10 && !submitting;
  const speechWindow = typeof window === 'undefined' ? undefined : (window as SpeechWindow);
  const SpeechRecognition =
    speechWindow?.SpeechRecognition ?? speechWindow?.webkitSpeechRecognition;
  const voiceAvailable = voiceInputEnabled && SpeechRecognition !== undefined;
  const modelOptions = [
    ...new Set(
      allowedModels.filter((value) => {
        return MODEL_IDENTIFIER_PATTERN.test(value);
      }),
    ),
  ];

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    setTextareaRowCount(renderedTextareaRows(textarea));
  }, [prompt]);

  const startCreation = async (retry = false): Promise<void> => {
    if (submitting) return;
    if (!retry && !canSubmit) return;
    setSubmitting(true);
    setSubmitError(false);
    setDetailsOpen(false);
    try {
      let pending = retry ? pendingCreationRef.current : undefined;
      if (pending === undefined) {
        const budgetNumber = budget.length === 0 ? undefined : Number(budget);
        if (budgetNumber !== undefined && (!Number.isInteger(budgetNumber) || budgetNumber <= 0)) {
          throw new RangeError('invalid_budget');
        }
        pending = {
          attachmentKeys: imagesRef.current.map(() => crypto.randomUUID()),
          attachmentMessageKey: crypto.randomUUID(),
          appType,
          files: imagesRef.current.map(({ file }) => file),
          ...(selectedModel === undefined ? {} : { model: selectedModel }),
          projectBody: {
            name: deriveProjectTitle(trimmedPrompt),
            sourceType: 'prompt',
          },
          projectIdempotencyKey: crypto.randomUUID(),
          prompt: trimmedPrompt,
          requestedBranch: targetBranch.trim(),
          ...(budgetNumber === undefined ? {} : { runBudget: { maxCredits: budgetNumber } }),
          runIdempotencyKey: crypto.randomUUID(),
          runMode: mode === 'auto' ? recommendedMode(trimmedPrompt) : mode,
          uploads: new Map(),
        };
        pendingCreationRef.current = pending;
      }
      const client = createControlPlaneClient(organizationId);
      const created = await client.createProject(
        pending.projectBody,
        pending.projectIdempotencyKey,
      );
      captureProjectCreated({ organizationId, projectId: created.project.id });
      const requestedBranch = pending.requestedBranch || created.repository.defaultBranch;
      const branch = created.branches.find((candidate) => candidate.name === requestedBranch);
      if (branch === undefined) throw new RangeError('target_branch_not_found');
      const attachments = await Promise.all(
        pending.files.map(async (file, index) => {
          const cached = pending.uploads.get(index);
          if (cached !== undefined) return cached;
          const uploaded = await client.uploadAttachment(
            created.project.id,
            file,
            pending.attachmentKeys[index],
          );
          pending.uploads.set(index, uploaded);
          return uploaded;
        }),
      );
      pending.runBody ??= {
        appType: pending.appType,
        branchId: branch.id,
        ...(pending.runBudget === undefined ? {} : { budget: pending.runBudget }),
        mode: pending.runMode,
        ...(pending.model === undefined ? {} : { model: pending.model }),
        prompt: pending.prompt,
      };
      const createdRun = await client.createRun(
        created.project.id,
        pending.runBody,
        pending.runIdempotencyKey,
      );
      if (attachments.length > 0) {
        await client.sendRunMessage(
          createdRun.run.id,
          {
            attachments: [...attachments],
            content: 'Use this visual reference with my initial request.',
          },
          pending.attachmentMessageKey,
        );
      }
      rememberFirstPrompt(created.project.id, pending.prompt);
      pendingCreationRef.current = undefined;
      imagesRef.current = [];
      setImages([]);
      router.push(`/projects/${encodeURIComponent(created.project.id)}`);
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void => {
    event.preventDefault();
    void startCreation();
  };

  const chooseMode = (selected: ComposerMode): void => {
    setMode(selected);
  };

  const addImages = (files: readonly File[]): void => {
    const selected = selectImageFiles(
      imagesRef.current.length,
      files.map((file) => ({ file, id: crypto.randomUUID() })),
    );
    const next = [...imagesRef.current, ...selected.accepted];
    imagesRef.current = next;
    setImages(next);
    setImageError(selected.error);
  };

  const uploadFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    addImages(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = '';
  };

  const pasteImages = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length === 0) return;
    event.preventDefault();
    addImages(files);
  };

  const startVoiceInput = (): void => {
    if (SpeechRecognition === undefined) return;
    setVoiceError(false);
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript.trim();
      if (transcript !== undefined && transcript.length > 0) {
        onPromptChange(`${prompt.trim()} ${transcript}`.trim());
      }
    };
    recognition.onerror = () => {
      setVoiceError(true);
    };
    recognition.onend = () => {
      textareaRef.current?.focus();
    };
    recognition.start();
  };

  return (
    <section className={`zapp-card ${styles.composerCard ?? ''}`}>
      <form onSubmit={submit}>
        <div className={styles.selectionChips} aria-live="polite">
          {mode === 'auto' ? null : (
            <span
              aria-label={`Selected mode: ${MODE_OPTIONS.find((item) => item.value === mode)?.label ?? mode}`}
              className={styles.selectionChip}
            >
              {MODE_OPTIONS.find((item) => item.value === mode)?.label}
            </span>
          )}
          {selectedModel === undefined ? null : (
            <span aria-label={`Selected model: ${selectedModel}`} className={styles.selectionChip}>
              {selectedModel}
            </span>
          )}
        </div>
        <div aria-label="Attached images" className={styles.selectionChips} role="list">
          {images.map((image) => (
            <span className={styles.selectionChip} key={image.id} role="listitem">
              {image.file.name}
              <button
                aria-label={`Remove ${image.file.name}`}
                onClick={() => {
                  const next = imagesRef.current.filter((candidate) => candidate.id !== image.id);
                  imagesRef.current = next;
                  setImages(next);
                  setImageError(undefined);
                }}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <label className="zapp-sr-only" htmlFor="home-prompt">
          Describe your project
        </label>
        <textarea
          className={styles.composerTextarea}
          id="home-prompt"
          onChange={(event) => {
            setTextareaRowCount(renderedTextareaRows(event.currentTarget));
            onPromptChange(event.target.value);
          }}
          onPaste={pasteImages}
          placeholder="Describe your idea. zapp will build, test, and ship it."
          ref={textareaRef}
          rows={textareaRowCount}
          value={prompt}
        />
        <div className={styles.composerActions} data-testid="project-composer-actions">
          <IconButton
            aria-expanded={attachmentMenuOpen}
            label="Add attachment or controls"
            onClick={() => {
              setAttachmentMenuOpen((open) => !open);
              setAdvancedOpen(false);
              setModeMenuOpen(false);
            }}
          >
            <span aria-hidden="true">+</span>
          </IconButton>
          <span className={styles.composerActionSpacer} />
          {voiceAvailable ? (
            <IconButton label="Voice input" onClick={startVoiceInput}>
              <span aria-hidden="true">◉</span>
            </IconButton>
          ) : null}
          <IconButton disabled={!canSubmit} label="Create project" type="submit">
            <span aria-hidden="true">↑</span>
          </IconButton>
        </div>

        {attachmentMenuOpen ? (
          <div className={styles.attachmentMenu} aria-label="Attachment and run controls">
            <label className={styles.menuItem}>
              Upload file
              <input
                accept="image/gif,image/jpeg,image/png,image/webp"
                aria-label="Upload file"
                className={styles.fileInput}
                multiple
                onChange={uploadFiles}
                type="file"
              />
            </label>
            {githubImportEnabled ? (
              <Link
                className={styles.menuItem}
                href="/projects?import=github"
                {...(onGitHubImport === undefined ? {} : { onClick: onGitHubImport })}
              >
                Import from GitHub
              </Link>
            ) : null}
            <button
              className={styles.menuItem}
              onClick={() => {
                setModeMenuOpen((open) => !open);
                setAdvancedOpen(false);
              }}
              type="button"
            >
              {mode === 'auto' ? 'Auto' : MODE_OPTIONS.find((item) => item.value === mode)?.label} ▸
            </button>
            <button
              className={styles.menuItem}
              onClick={() => {
                setAdvancedOpen((open) => !open);
                setModeMenuOpen(false);
              }}
              type="button"
            >
              Advanced controls
            </button>

            {modeMenuOpen ? (
              <div className={styles.submenu}>
                <fieldset className={styles.fieldset}>
                  <legend>Mode</legend>
                  {MODE_OPTIONS.map((option) => (
                    <label className={styles.radioOption} key={option.value}>
                      <input
                        checked={mode === option.value}
                        name="home-mode"
                        onChange={() => {
                          chooseMode(option.value);
                        }}
                        type="radio"
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <fieldset className={styles.fieldset}>
                  <legend>Model</legend>
                  <label className={styles.radioOption}>
                    <input
                      checked={selectedModel === undefined}
                      name="home-model"
                      onChange={() => {
                        setSelectedModel(undefined);
                      }}
                      type="radio"
                    />
                    <span>
                      <strong>Automatic</strong>
                      <small>Automatic selection managed by your organization.</small>
                    </span>
                  </label>
                  {modelOptions.map((model) => (
                    <label className={styles.radioOption} key={model}>
                      <input
                        checked={selectedModel === model}
                        name="home-model"
                        onChange={() => {
                          setSelectedModel(model);
                        }}
                        type="radio"
                      />
                      <span>
                        <strong>{model}</strong>
                      </span>
                    </label>
                  ))}
                </fieldset>
              </div>
            ) : null}

            {advancedOpen ? (
              <div className={styles.submenu}>
                <label className={styles.fieldLabel}>
                  Run budget cap
                  <input
                    min="1"
                    onChange={(event) => {
                      setBudget(event.target.value);
                    }}
                    step="1"
                    type="number"
                    value={budget}
                  />
                </label>
                <label className={styles.fieldLabel}>
                  Target branch
                  <input
                    onChange={(event) => {
                      setTargetBranch(event.target.value);
                    }}
                    type="text"
                    value={targetBranch}
                  />
                </label>
              </div>
            ) : null}
          </div>
        ) : null}
        <p aria-live="polite" className={styles.composerStatus}>
          {submitting ? 'Starting your project…' : null}
          {voiceError ? 'Voice input could not start. You can continue typing.' : null}
        </p>
        {imageError === undefined ? null : <p role="alert">{imageError}</p>}
      </form>

      {submitError ? (
        <ErrorState
          description={
            detailsOpen
              ? 'Request failed before the project handoff completed.'
              : 'Your prompt is safe. Choose an action to continue.'
          }
          onAskAgent={() => {
            window.location.href = 'mailto:support@zapp.build?subject=Project%20creation%20help';
          }}
          onFixAutomatically={() => {
            setSubmitError(false);
            void startCreation(true);
          }}
          onInspectDetails={() => {
            setDetailsOpen((open) => !open);
          }}
          onRetry={() => {
            void startCreation(true);
          }}
          title="We could not start your project."
        />
      ) : null}
    </section>
  );
}
