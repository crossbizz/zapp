'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type RunEvidenceData } from '../../lib/api';

export function EvidenceViewer({ artifactId, organizationId, runId, taskId }: { readonly artifactId: string; readonly organizationId: string; readonly runId: string; readonly taskId?: string }): ReactElement {
  const [data, setData] = useState<RunEvidenceData>();
  useEffect(() => { const controller = new AbortController(); void createControlPlaneClient(organizationId).getRunEvidence(runId, artifactId, taskId, controller.signal).then(setData); return () => { controller.abort(); }; }, [artifactId, organizationId, runId, taskId]);
  if (data === undefined) return <p role="status">Loading evidence…</p>;
  return <article aria-label="Test evidence"><h4>{data.artifact.kind}</h4><p>{data.artifact.description ?? 'Verification evidence'}</p>{data.artifact.kind === 'screenshot' ? <img alt={data.artifact.description ?? 'Verification screenshot'} src={data.download.url} /> : null}<a href={data.download.url}>Download {data.artifact.kind}</a></article>;
}
