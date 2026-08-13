'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type WorkspaceFileData, type WorkspaceFilesData } from '../../lib/api';
import { FileTree } from './FileTree';
import { DiffView } from './DiffView';

function decodeBase64(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
}
function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function CodeView({ organizationId, projectId, view }: { readonly organizationId: string; readonly projectId: string; readonly view: 'files' | 'changes' }): ReactElement {
  const client = createControlPlaneClient(organizationId);
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [entries, setEntries] = useState<WorkspaceFilesData['entries']>([]);
  const [file, setFile] = useState<WorkspaceFileData>();
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [status, setStatus] = useState('Loading files…');
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([client.listProjectWorkspaces(projectId, controller.signal), client.getMe()]).then(async ([workspaces, me]) => {
      const workspace = workspaces.workspaces[0];
      if (workspace === undefined) { setStatus('No active workspace'); return; }
      setWorkspaceId(workspace.id);
      const membership = me.memberships.find((item) => item.organization.id === organizationId);
      setCanEdit(membership?.role === 'owner' || membership?.role === 'builder');
      const listed = await client.listWorkspaceFiles(workspace.id, '.', controller.signal);
      setEntries(listed.entries); setStatus('');
    }).catch(() => { if (!controller.signal.aborted) setStatus('Files could not be loaded.'); });
    return () => { controller.abort(); };
  }, [organizationId, projectId, view]);
  const open = async (path: string): Promise<void> => {
    if (workspaceId === undefined) return;
    try { const loaded = await client.readWorkspaceFile(workspaceId, path); setFile(loaded); setContent(decodeBase64(loaded.dataBase64)); setEditing(false); setStatus(''); }
    catch { setStatus('The file could not be opened.'); }
  };
  const save = async (): Promise<void> => {
    if (workspaceId === undefined || file === undefined) return;
    try { const saved = await client.editWorkspaceFile(workspaceId, { path: file.path, dataBase64: encodeBase64(content), expectedCompareToken: file.compareToken }); setFile({ ...file, dataBase64: encodeBase64(content), compareToken: saved.compareToken, byteSize: new TextEncoder().encode(content).byteLength }); setEditing(false); setStatus(`Saved in ${saved.commitRef}`); }
    catch { setStatus('The file changed or could not be saved. Reload and retry.'); }
  };
  return <section aria-label={view === 'changes' ? 'Code changes' : 'Files workspace'}><FileTree entries={entries} onOpen={(path) => { void open(path); }} />
    {file === undefined ? null : <article><h3>{file.path}</h3>{editing ? <textarea aria-label="File editor" onChange={(event) => { setContent(event.target.value); }} value={content} /> : <pre>{content}</pre>}{canEdit ? <button onClick={() => { if (editing) void save(); else setEditing(true); }} type="button">{editing ? 'Save edit' : 'Edit file'}</button> : null}</article>}
    <p aria-live="polite">{status}</p>
    {view === 'changes' ? <DiffView organizationId={organizationId} projectId={projectId} /> : null}
  </section>;
}
