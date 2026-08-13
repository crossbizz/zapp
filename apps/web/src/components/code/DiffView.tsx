'use client';

import { useState, type ReactElement } from 'react';

import { createControlPlaneClient, type CommitComparisonData } from '../../lib/api';

export function DiffView({ organizationId, projectId }: { readonly organizationId: string; readonly projectId: string }): ReactElement {
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [comparison, setComparison] = useState<CommitComparisonData>();
  const [error, setError] = useState('');
  const compare = async (): Promise<void> => {
    setError('');
    try { setComparison(await createControlPlaneClient(organizationId).compareProjectCommits(projectId, before, after)); }
    catch { setError('The commit comparison could not be loaded.'); }
  };
  return <section aria-label="Commit comparison">
    <label>Before commit<input maxLength={40} onChange={(event) => { setBefore(event.target.value); }} value={before} /></label>
    <label>After commit<input maxLength={40} onChange={(event) => { setAfter(event.target.value); }} value={after} /></label>
    <button disabled={!/^[0-9a-f]{40}$/u.test(before) || !/^[0-9a-f]{40}$/u.test(after)} onClick={() => { void compare(); }} type="button">Compare</button>
    {comparison === undefined ? null : <><p>{comparison.changedFiles} changed files</p><ul>{comparison.files.map((file) => <li key={file.path}>{file.path} +{file.additions} −{file.deletions}</li>)}</ul><pre>{comparison.patch}</pre></>}
    {error === '' ? null : <p role="alert">{error}</p>}
  </section>;
}
