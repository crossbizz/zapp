'use client';

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { createControlPlaneClient } from '../../lib/api';

export function LogView({ organizationId, projectId }: { readonly organizationId: string; readonly projectId: string }): ReactElement {
  const client = useMemo(() => createControlPlaneClient(organizationId), [organizationId]);
  const [lines, setLines] = useState<readonly { cursor: number; stream: string; message: string }[]>([]);
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const [status, setStatus] = useState('Loading logs…');
  useEffect(() => {
    const controller = new AbortController();
    let interval = 0;
    void client.listProjectWorkspaces(projectId, controller.signal).then((response) => {
      const workspace = response.workspaces[0];
      if (workspace === undefined) { setStatus('No active workspace'); return; }
      const load = async (): Promise<void> => {
        const logs = await client.readDevServerLogs(workspace.id, 0, controller.signal);
        setLines(logs.entries); setStatus('');
      };
      void load().catch(() => { setStatus('Logs could not be loaded.'); });
      interval = window.setInterval(() => { if (follow) void load(); }, 2_000);
    }).catch(() => { if (!controller.signal.aborted) setStatus('Logs could not be loaded.'); });
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [client, follow, projectId]);
  const visible = lines.filter(({ message }) => message.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section aria-label="Runtime logs"><label>Search logs<input onChange={(event) => { setSearch(event.target.value); }} value={search} /></label><label><input checked={follow} onChange={(event) => { setFollow(event.target.checked); }} type="checkbox" />Follow</label><pre>{visible.map((entry) => `[${entry.stream}] ${entry.message}`).join('\n')}</pre><p aria-live="polite">{status}</p></section>;
}
