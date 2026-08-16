'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import {
  createControlPlaneClient,
  type WorkspaceFileData,
  type WorkspaceFilesData,
} from '../../lib/api';
import { ensureProjectWorkspace } from '../builder/workspace-session';
import { CodeEditor } from './CodeEditor';
import { DiffView } from './DiffView';
import { FileTree } from './FileTree';
import styles from './code.module.css';
import { isVisibleWorkspacePath } from './workspace-paths';

interface OpenFileTab {
  readonly content: string;
  readonly file: WorkspaceFileData;
}

function decodeBase64(value: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  );
}

function canonicalWorkspacePath(directory: string, entryPath: string): string {
  if (directory === '.' || entryPath === directory || entryPath.startsWith(`${directory}/`)) {
    return entryPath;
  }
  return `${directory}/${entryPath}`;
}

function baseName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function ToolbarIcon({ type }: { readonly type: 'copy' | 'download' | 'reference' }): ReactElement {
  if (type === 'reference') {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20">
        <path d="M3 3.5h14v10H9l-4 3v-3H3v-10Z" />
        <path d="M7 8.5h6M10 5.5v6" />
      </svg>
    );
  }
  if (type === 'copy') {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20">
        <rect height="10" rx="1.5" width="9" x="7.5" y="3.5" />
        <path d="M12.5 16.5h-8a1 1 0 0 1-1-1v-9" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 5.5v8M6.5 10l3.5 3.5 3.5-3.5" />
    </svg>
  );
}

export interface CodeViewProps {
  readonly branchId: string;
  readonly onReferenceFile: (path: string) => void;
  readonly organizationId: string;
  readonly projectId: string;
  readonly view: 'files' | 'changes';
}

export function CodeView({
  branchId,
  onReferenceFile,
  organizationId,
  projectId,
  view,
}: CodeViewProps): ReactElement {
  const client = useMemo(() => createControlPlaneClient(organizationId), [organizationId]);
  const scopeKey = `${organizationId}:${projectId}:${branchId}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const readControllersRef = useRef(new Set<AbortController>());
  const pendingPathsRef = useRef(new Set<string>());
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [entries, setEntries] = useState<WorkspaceFilesData['entries']>([]);
  const [tabs, setTabs] = useState<readonly OpenFileTab[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [status, setStatus] = useState('Loading files…');

  useEffect(() => {
    const controller = new AbortController();
    for (const readController of readControllersRef.current) readController.abort();
    readControllersRef.current.clear();
    pendingPathsRef.current.clear();
    setWorkspaceId(undefined);
    setEntries([]);
    setTabs([]);
    setActivePath(undefined);
    setStatus('Loading files…');
    void ensureProjectWorkspace(client, {
      branchId,
      projectId,
      signal: controller.signal,
    })
      .then(async ({ workspace }) => {
        const listed = await client.listWorkspaceFiles(workspace.id, '.', controller.signal);
        if (controller.signal.aborted || scopeKeyRef.current !== scopeKey) return;
        setWorkspaceId(workspace.id);
        setEntries(listed.entries.filter((entry) => isVisibleWorkspacePath(entry.path)));
        setStatus('');
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus('Files could not be restored from the project branch.');
        }
      });
    return () => {
      controller.abort();
      for (const readController of readControllersRef.current) readController.abort();
      readControllersRef.current.clear();
    };
  }, [branchId, client, projectId, scopeKey]);

  const open = useCallback(
    async (path: string): Promise<void> => {
      const existing = tabs.find((tab) => tab.file.path === path);
      if (existing !== undefined) {
        setActivePath(path);
        return;
      }
      if (workspaceId === undefined || pendingPathsRef.current.has(path)) return;
      pendingPathsRef.current.add(path);
      const controller = new AbortController();
      readControllersRef.current.add(controller);
      const requestedScope = scopeKey;
      try {
        const loaded = await client.readWorkspaceFile(workspaceId, path, controller.signal);
        if (controller.signal.aborted || scopeKeyRef.current !== requestedScope) return;
        const tab = { content: decodeBase64(loaded.dataBase64), file: loaded };
        setTabs((current) =>
          current.some((candidate) => candidate.file.path === path) ? current : [...current, tab],
        );
        setActivePath(path);
        setStatus('');
      } catch {
        if (!controller.signal.aborted) setStatus('The file could not be opened.');
      } finally {
        pendingPathsRef.current.delete(path);
        readControllersRef.current.delete(controller);
      }
    },
    [client, scopeKey, tabs, workspaceId],
  );

  const openDirectory = useCallback(
    async (path: string): Promise<void> => {
      if (workspaceId === undefined) return;
      const controller = new AbortController();
      readControllersRef.current.add(controller);
      const requestedScope = scopeKey;
      try {
        const listed = await client.listWorkspaceFiles(workspaceId, path, controller.signal);
        if (controller.signal.aborted || scopeKeyRef.current !== requestedScope) return;
        setEntries((current) => {
          const merged = new Map(current.map((entry) => [entry.path, entry]));
          for (const entry of listed.entries) {
            const canonicalPath = canonicalWorkspacePath(path, entry.path);
            if (isVisibleWorkspacePath(canonicalPath)) {
              merged.set(canonicalPath, { ...entry, path: canonicalPath });
            }
          }
          return [...merged.values()];
        });
        setStatus('');
      } catch {
        if (!controller.signal.aborted) setStatus('The folder could not be opened.');
      } finally {
        readControllersRef.current.delete(controller);
      }
    },
    [client, scopeKey, workspaceId],
  );
  const handleOpen = useCallback(
    (path: string): void => {
      void open(path);
    },
    [open],
  );
  const handleOpenDirectory = useCallback(
    (path: string): void => {
      void openDirectory(path);
    },
    [openDirectory],
  );

  const activeTab = tabs.find((tab) => tab.file.path === activePath);

  const closeTab = (path: string): void => {
    setTabs((current) => {
      const closingIndex = current.findIndex((tab) => tab.file.path === path);
      if (closingIndex < 0) return current;
      const nextTabs = current.filter((tab) => tab.file.path !== path);
      setActivePath((selected) => {
        if (selected !== path) return selected;
        return nextTabs[closingIndex]?.file.path ?? nextTabs[closingIndex - 1]?.file.path;
      });
      return nextTabs;
    });
  };

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'End', 'Home'].includes(event.key)) return;
    const tabButtons = [
      ...(event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ) ?? []),
    ];
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    if (currentIndex < 0 || tabButtons.length === 0) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabButtons.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) %
            tabButtons.length;
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  const copyContent = async (): Promise<void> => {
    if (activeTab === undefined) return;
    try {
      await navigator.clipboard.writeText(activeTab.content);
      setStatus(`Copied ${activeTab.file.path}`);
    } catch {
      setStatus('The file content could not be copied.');
    }
  };

  const download = (): void => {
    if (activeTab === undefined) return;
    try {
      const url = URL.createObjectURL(new Blob([activeTab.content], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = baseName(activeTab.file.path);
      link.click();
      URL.revokeObjectURL(url);
      setStatus(`Downloaded ${activeTab.file.path}`);
    } catch {
      setStatus('The file could not be downloaded.');
    }
  };

  return (
    <section
      aria-label={view === 'changes' ? 'Code changes' : 'Files workspace'}
      className={styles.workspace}
    >
      <FileTree
        {...(activePath === undefined ? {} : { activePath })}
        entries={entries}
        key={workspaceId ?? scopeKey}
        onOpen={handleOpen}
        onOpenDirectory={handleOpenDirectory}
      />
      <div className={styles.editor}>
        <header className={styles.editorHeader}>
          <div aria-label="Open file tabs" className={styles.openTabs} role="tablist">
            {tabs.map((tab) => (
              <span className={styles.tabItem} data-active={activePath === tab.file.path ? 'true' : 'false'} key={tab.file.path}>
                <button
                  aria-selected={activePath === tab.file.path}
                  className={styles.fileTab}
                  onClick={() => {
                    setActivePath(tab.file.path);
                  }}
                  onKeyDown={moveTabFocus}
                  role="tab"
                  tabIndex={activePath === tab.file.path ? 0 : -1}
                  title={tab.file.path}
                  type="button"
                >
                  {tab.file.path}
                </button>
                <button
                  aria-label={`Close ${tab.file.path}`}
                  className={styles.closeTab}
                  onClick={() => {
                    closeTab(tab.file.path);
                  }}
                  title={`Close ${tab.file.path}`}
                  type="button"
                >
                  <svg aria-hidden="true" viewBox="0 0 20 20">
                    <path d="m6 6 8 8M14 6l-8 8" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
          {activeTab === undefined ? null : (
            <div aria-label="File actions" className={styles.fileActions} role="toolbar">
              <button
                aria-label="Reference file in chat"
                onClick={() => {
                  onReferenceFile(activeTab.file.path);
                  setStatus(`Added @${activeTab.file.path} to chat`);
                }}
                title="Reference file in chat"
                type="button"
              >
                <ToolbarIcon type="reference" />
              </button>
              <button
                aria-label="Copy file content"
                onClick={() => {
                  void copyContent();
                }}
                title="Copy file content"
                type="button"
              >
                <ToolbarIcon type="copy" />
              </button>
              <button
                aria-label="Download file"
                onClick={download}
                title="Download file"
                type="button"
              >
                <ToolbarIcon type="download" />
                <span>Download</span>
              </button>
            </div>
          )}
        </header>
        <div className={styles.fileSurface}>
          {activeTab === undefined ? (
            <div className={styles.empty}>
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M6 3.5h8l4 4V20H6V3.5ZM14 3.5V8h4" />
              </svg>
              <p>Select a file to view its contents.</p>
            </div>
          ) : (
            <CodeEditor path={activeTab.file.path} value={activeTab.content} />
          )}
        </div>
        {view === 'changes' ? (
          <div className={styles.comparison}>
            <DiffView organizationId={organizationId} projectId={projectId} />
          </div>
        ) : null}
      </div>
      <p aria-live="polite" className={styles.status} role="status">
        {status}
      </p>
    </section>
  );
}
