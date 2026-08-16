import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { WorkspaceFilesData } from '../../lib/api';
import styles from './code.module.css';
import { isVisibleWorkspacePath } from './workspace-paths';

type WorkspaceEntry = WorkspaceFilesData['entries'][number];

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

function baseName(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? path : path.slice(separator + 1);
}

function FileTypeIcon({ entry }: { readonly entry: WorkspaceEntry }): ReactElement | null {
  if (entry.type === 'directory') return null;
  const name = baseName(entry.path);
  const extension = entry.path.split('.').at(-1)?.toLocaleLowerCase('en-US');
  if (extension === 'tsx' || extension === 'jsx') {
    return (
      <svg
        aria-hidden="true"
        className={styles.reactIcon}
        data-file-icon="react"
        viewBox="0 0 20 20"
      >
        <ellipse cx="10" cy="10" rx="7" ry="2.7" />
        <ellipse cx="10" cy="10" rx="7" ry="2.7" transform="rotate(60 10 10)" />
        <ellipse cx="10" cy="10" rx="7" ry="2.7" transform="rotate(120 10 10)" />
        <circle cx="10" cy="10" r="1.3" />
      </svg>
    );
  }
  if (name.startsWith('vite.config.')) {
    return (
      <svg
        aria-hidden="true"
        className={styles.fileIcon}
        data-file-icon="vite"
        viewBox="0 0 20 20"
      >
        <path d="M11.5 1.8 4 11h5l-.7 7.2L16 8.5h-5l.5-6.7Z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (extension === 'ts' || extension === 'js') {
    return (
      <span
        aria-hidden="true"
        className={styles.fileBadge}
        data-file-icon={extension === 'ts' ? 'typescript' : 'javascript'}
      >
        {extension === 'ts' ? 'TS' : 'JS'}
      </span>
    );
  }
  if (extension === 'css') {
    return (
      <span aria-hidden="true" className={styles.fileBadge} data-file-icon="css">
        CSS
      </span>
    );
  }
  if (extension === 'json' || extension === 'jsonc') {
    return (
      <span aria-hidden="true" className={styles.fileGlyph} data-file-icon="json">
        {'{ }'}
      </span>
    );
  }
  if (extension === 'md' || extension === 'mdx') {
    return (
      <span aria-hidden="true" className={styles.fileGlyph} data-file-icon="markdown">
        M↓
      </span>
    );
  }
  if (name.startsWith('.git')) {
    return (
      <svg
        aria-hidden="true"
        className={styles.fileIcon}
        data-file-icon="git"
        viewBox="0 0 20 20"
      >
        <path d="m10 1.8 8.2 8.2-8.2 8.2L1.8 10 10 1.8Z" fill="currentColor" stroke="none" />
        <path d="M7 6.5v5.8m0-3.8 4.5 3.2V8" stroke="white" strokeWidth="1.2" />
        <circle cx="7" cy="6.2" r="1.2" fill="white" stroke="none" />
        <circle cx="7" cy="13.3" r="1.2" fill="white" stroke="none" />
        <circle cx="11.5" cy="7.5" r="1.2" fill="white" stroke="none" />
      </svg>
    );
  }
  if (name.startsWith('.prettier')) {
    return (
      <svg
        aria-hidden="true"
        className={styles.fileIcon}
        data-file-icon="prettier"
        viewBox="0 0 20 20"
      >
        <path d="M3 4h3M8 4h7M3 7h6m2 0h6M3 10h3m2 0h7M3 13h7m2 0h5M3 16h3m2 0h5" />
      </svg>
    );
  }
  if (name.endsWith('.lock')) {
    return (
      <svg
        aria-hidden="true"
        className={styles.fileIcon}
        data-file-icon="lockfile"
        viewBox="0 0 20 20"
      >
        <path d="M2.5 10c0-3.5 3.4-6.3 7.5-6.3s7.5 2.8 7.5 6.3-3.4 6.3-7.5 6.3S2.5 13.5 2.5 10Z" fill="currentColor" stroke="none" />
        <circle cx="6.4" cy="9.3" r="1" fill="white" stroke="none" />
        <circle cx="10" cy="11.2" r="1" fill="white" stroke="none" />
        <circle cx="13.6" cy="9.3" r="1" fill="white" stroke="none" />
      </svg>
    );
  }
  if (['avif', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension ?? '')) {
    return (
      <svg
        aria-hidden="true"
        className={styles.fileIcon}
        data-file-icon="image"
        viewBox="0 0 20 20"
      >
        <rect height="13" rx="1.5" width="15" x="2.5" y="3.5" />
        <circle cx="7" cy="8" r="1.4" fill="currentColor" stroke="none" />
        <path d="m4.5 14 4-3.5 2.4 2 2.1-1.8 2.5 3.3" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      className={styles.fileIcon}
      data-file-icon="file"
      viewBox="0 0 20 20"
    >
      <path d="M4 2.5h7l4.5 4.5v10.5H4v-15Z" />
      <path d="M11 2.5V7h4.5" />
    </svg>
  );
}

export interface FileTreeProps {
  readonly activePath?: string;
  readonly entries: WorkspaceFilesData['entries'];
  readonly onOpen: (path: string) => void;
  readonly onOpenDirectory: (path: string) => void;
}

export function FileTree({
  activePath,
  entries,
  onOpen,
  onOpenDirectory,
}: FileTreeProps): ReactElement {
  const [query, setQuery] = useState('');
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(new Set());
  const [expandingAll, setExpandingAll] = useState(false);
  const requestedDirectoriesRef = useRef(new Set<string>());

  useEffect(() => {
    if (!expandingAll) return;
    const directories = entries.filter((entry) => entry.type === 'directory');
    setExpandedDirectories(new Set(directories.map((entry) => entry.path)));
    for (const directory of directories) {
      if (requestedDirectoriesRef.current.has(directory.path)) continue;
      requestedDirectoriesRef.current.add(directory.path);
      onOpenDirectory(directory.path);
    }
  }, [entries, expandingAll, onOpenDirectory]);

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    const available = entries.filter((entry) => isVisibleWorkspacePath(entry.path));
    const byParent = new Map<string, WorkspaceEntry[]>();
    for (const entry of available) {
      const siblings = byParent.get(parentPath(entry.path)) ?? [];
      siblings.push(entry);
      byParent.set(parentPath(entry.path), siblings);
    }
    for (const siblings of byParent.values()) {
      siblings.sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return baseName(left.path).localeCompare(baseName(right.path));
      });
    }
    const matches = new Set(
      normalizedQuery.length === 0
        ? []
        : available
            .filter((entry) => entry.path.toLocaleLowerCase('en-US').includes(normalizedQuery))
            .map((entry) => entry.path),
    );
    const includesMatch = (path: string): boolean =>
      normalizedQuery.length === 0 ||
      matches.has(path) ||
      [...matches].some((match) => match.startsWith(`${path}/`));
    const flattened: Array<{ readonly depth: number; readonly entry: WorkspaceEntry }> = [];
    const appendChildren = (parent: string, depth: number): void => {
      for (const entry of byParent.get(parent) ?? []) {
        if (!includesMatch(entry.path)) continue;
        flattened.push({ depth, entry });
        if (
          entry.type === 'directory' &&
          (normalizedQuery.length > 0 || expandedDirectories.has(entry.path))
        ) {
          appendChildren(entry.path, depth + 1);
        }
      }
    };
    appendChildren('', 0);
    return flattened;
  }, [entries, expandedDirectories, query]);

  const expandAll = (): void => {
    setExpandingAll(true);
    const directories = entries.filter((entry) => entry.type === 'directory');
    setExpandedDirectories(new Set(directories.map((entry) => entry.path)));
    for (const directory of directories) {
      if (requestedDirectoriesRef.current.has(directory.path)) continue;
      requestedDirectoriesRef.current.add(directory.path);
      onOpenDirectory(directory.path);
    }
  };

  const collapseAll = (): void => {
    setExpandingAll(false);
    setExpandedDirectories(new Set());
  };

  return (
    <nav aria-label="Code explorer" className={styles.sidebar}>
      <div className={styles.explorerHeader}>
        <input
          aria-label="Search code"
          className={styles.search}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          placeholder="Search code"
          type="search"
          value={query}
        />
        <button
          aria-label={expandingAll ? 'Collapse all folders' : 'Expand all folders'}
          className={styles.treeControl}
          onClick={expandingAll ? collapseAll : expandAll}
          title={expandingAll ? 'Collapse all folders' : 'Expand all folders'}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20">
            <path d={expandingAll ? 'm6 7 4 4 4-4M6 13l4 4 4-4' : 'm6 3 4 4 4-4M6 11l4 4 4-4'} />
          </svg>
        </button>
      </div>
      <ul aria-label="Workspace files" className={styles.tree} role="tree">
        {visibleEntries.map(({ depth, entry }) => {
          const expanded = entry.type === 'directory' && expandedDirectories.has(entry.path);
          return (
            <li
              aria-expanded={entry.type === 'directory' ? expanded : undefined}
              aria-level={depth + 1}
              aria-selected={entry.type === 'file' ? activePath === entry.path : undefined}
              key={entry.path}
              role="treeitem"
            >
              <button
                aria-label={entry.path}
                className={styles.entry}
                data-active={activePath === entry.path ? 'true' : 'false'}
                onClick={() => {
                  if (entry.type === 'file') {
                    onOpen(entry.path);
                    return;
                  }
                  const expanding = !expanded;
                  setExpandedDirectories((current) => {
                    const next = new Set(current);
                    if (expanding) next.add(entry.path);
                    else next.delete(entry.path);
                    return next;
                  });
                  if (expanding && !requestedDirectoriesRef.current.has(entry.path)) {
                    requestedDirectoriesRef.current.add(entry.path);
                    onOpenDirectory(entry.path);
                  }
                }}
                style={{ paddingLeft: `${String(0.55 + depth * 0.9)}rem` }}
                title={entry.path}
                type="button"
              >
                {entry.type === 'directory' ? (
                  <svg aria-hidden="true" className={styles.chevron} viewBox="0 0 20 20">
                    <path d="m7 5 5 5-5 5" transform={expanded ? 'rotate(90 10 10)' : undefined} />
                  </svg>
                ) : (
                  <span aria-hidden="true" className={styles.fileIndent} />
                )}
                <FileTypeIcon entry={entry} />
                <span className={styles.entryLabel}>{baseName(entry.path)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
