import type { ReactElement } from 'react';

import type { MissionControlData } from '../../lib/api';

export function FilesCommits({ data, onCompare }: { readonly data: MissionControlData; readonly onCompare: () => void }): ReactElement {
  return <section aria-label="Files and commits">
    <ul>{data.filesChanged.map((file) => <li key={file.path}>{file.path} <small>+{file.additions} −{file.deletions}</small></li>)}</ul>
    <ol>{data.commits.map((commit) => <li key={commit.sha}><code>{commit.sha.slice(0, 8)}</code> {commit.message ?? 'Commit'}</li>)}</ol>
    <button disabled={data.commits.length < 2} onClick={onCompare} type="button">Compare commits</button>
  </section>;
}
