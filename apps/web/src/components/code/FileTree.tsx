import { useMemo, useState, type ReactElement } from 'react';

import type { WorkspaceFilesData } from '../../lib/api';
import styles from './code.module.css';
import { isVisibleWorkspacePath } from './workspace-paths';

function parentPath(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

function baseName(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? path : path.slice(separator + 1);
}

export function FileTree({ entries, onOpen, onOpenDirectory }: { readonly entries: WorkspaceFilesData['entries']; readonly onOpen: (path: string) => void; readonly onOpenDirectory: (path: string) => void }): ReactElement {
  const [query, setQuery] = useState('');
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(new Set());
  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const available = entries.filter((entry) => isVisibleWorkspacePath(entry.path));
    const byParent = new Map<string, typeof available>();
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
            .filter((entry) => entry.path.toLocaleLowerCase().includes(normalizedQuery))
            .map((entry) => entry.path),
    );
    const includesMatch = (path: string): boolean =>
      normalizedQuery.length === 0 ||
      matches.has(path) ||
      [...matches].some((match) => match.startsWith(`${path}/`));
    const flattened: Array<{ readonly depth: number; readonly entry: (typeof available)[number] }> = [];
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
  return <nav aria-label="Workspace files" className={styles.sidebar}>
    <input aria-label="Search code" className={styles.search} onChange={(event) => { setQuery(event.target.value); }} placeholder="Search code" type="search" value={query} />
    <ul className={styles.tree}>{visibleEntries.map(({ depth, entry }) => <li key={entry.path} style={{ paddingLeft: `${String(depth * 0.8)}rem` }}>
      <button aria-expanded={entry.type === 'directory' ? expandedDirectories.has(entry.path) : undefined} aria-label={entry.path} className={styles.entry} onClick={() => {
        if (entry.type === 'file') {
          onOpen(entry.path);
          return;
        }
        const expanding = !expandedDirectories.has(entry.path);
        setExpandedDirectories((current) => {
          const next = new Set(current);
          if (expanding) next.add(entry.path);
          else next.delete(entry.path);
          return next;
        });
        if (expanding) onOpenDirectory(entry.path);
      }} title={entry.path} type="button">
        <span aria-hidden="true" className={entry.type === 'directory' && expandedDirectories.has(entry.path) ? [styles.icon, styles.iconExpanded].join(' ') : styles.icon}>{entry.type === 'file' ? '·' : '›'}</span>
        <span>{baseName(entry.path)}{entry.type === 'directory' ? '/' : ''}</span>
      </button>
    </li>)}</ul>
  </nav>;
}
