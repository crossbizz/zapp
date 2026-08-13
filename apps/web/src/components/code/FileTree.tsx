import type { ReactElement } from 'react';

import type { WorkspaceFilesData } from '../../lib/api';

export function FileTree({ entries, onOpen }: { readonly entries: WorkspaceFilesData['entries']; readonly onOpen: (path: string) => void }): ReactElement {
  return <nav aria-label="Workspace files"><ul>{entries.map((entry) => <li key={entry.path}>{entry.type === 'file' ? <button onClick={() => { onOpen(entry.path); }} type="button">{entry.path}</button> : <span>{entry.path}/</span>}</li>)}</ul></nav>;
}
