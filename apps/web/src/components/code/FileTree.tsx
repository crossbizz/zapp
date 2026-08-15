import { useMemo, useState, type ReactElement } from 'react';

import type { WorkspaceFilesData } from '../../lib/api';
import styles from './code.module.css';
import { isVisibleWorkspacePath } from './workspace-paths';

export function FileTree({ entries, onOpen, onOpenDirectory }: { readonly entries: WorkspaceFilesData['entries']; readonly onOpen: (path: string) => void; readonly onOpenDirectory: (path: string) => void }): ReactElement {
  const [query, setQuery] = useState('');
  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return entries
      .filter((entry) => isVisibleWorkspacePath(entry.path))
      .filter((entry) => normalizedQuery.length === 0 || entry.path.toLocaleLowerCase().includes(normalizedQuery))
      .toSorted((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.path.localeCompare(right.path);
      });
  }, [entries, query]);
  return <nav aria-label="Workspace files" className={styles.sidebar}>
    <input aria-label="Search code" className={styles.search} onChange={(event) => { setQuery(event.target.value); }} placeholder="Search code" type="search" value={query} />
    <ul className={styles.tree}>{visibleEntries.map((entry) => <li key={entry.path}>
      <button className={styles.entry} onClick={() => { if (entry.type === 'file') onOpen(entry.path); else onOpenDirectory(entry.path); }} title={entry.path} type="button">
        <span aria-hidden="true" className={styles.icon}>{entry.type === 'file' ? '·' : '›'}</span>
        <span>{entry.path}{entry.type === 'directory' ? '/' : ''}</span>
      </button>
    </li>)}</ul>
  </nav>;
}
