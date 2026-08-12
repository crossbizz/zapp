'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type BuilderRun, type RunTestsData } from '../../lib/api';
import { EvidenceViewer } from './EvidenceViewer';

export function TestRuns({ onRunCreated, organizationId, projectId, runId }: { readonly onRunCreated: (run: BuilderRun) => void; readonly organizationId: string; readonly projectId: string; readonly runId?: string }): ReactElement {
  const [data, setData] = useState<RunTestsData>();
  const [selectedEvidence, setSelectedEvidence] = useState<{ artifactId: string; taskId?: string }>();
  const [status, setStatus] = useState('');
  useEffect(() => { if (runId === undefined) return; const controller = new AbortController(); void createControlPlaneClient(organizationId).listRunTests(runId, controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setStatus('Tests could not be loaded.'); }); return () => { controller.abort(); }; }, [organizationId, runId]);
  if (runId === undefined) return <p>No test results yet</p>;
  return <section aria-label="Test results">{data?.runs.map((run) => <article key={run.id}><h3>{run.type}: {run.status}</h3><p>{run.completedAt === null ? 'Running' : `${String(Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt)))}ms`}</p><ul>{run.cases.map((testCase) => <li key={testCase.id}>{testCase.name} — {testCase.status}{testCase.durationMs === null ? '' : ` · ${String(testCase.durationMs)}ms`}{testCase.evidenceArtifactIds.map((artifactId) => <button key={artifactId} onClick={() => { setSelectedEvidence({ artifactId, ...(run.taskId === null ? {} : { taskId: run.taskId }) }); }} type="button">View evidence</button>)}{testCase.status === 'failed' && testCase.evidenceArtifactIds[0] !== undefined ? <button onClick={() => { const artifactId = testCase.evidenceArtifactIds[0]; if (artifactId === undefined) return; void createControlPlaneClient(organizationId).createRun(projectId, { appType: 'web', mode: 'fix', prompt: `Fix failing test: ${testCase.name}`, fixRequest: { source: 'failed_check', summary: testCase.name, relevantCommitSha: run.commitSha, reproductionRef: `test-case:${testCase.id}`, evidence: [{ kind: 'failed_check', artifactId, summary: testCase.name }] } }).then(({ run: created }) => { onRunCreated(created); setStatus('Fix run created.'); }).catch(() => { setStatus('Fix run could not be created.'); }); }} type="button">Create Fix run</button> : null}</li>)}</ul></article>)}{selectedEvidence === undefined ? null : <EvidenceViewer artifactId={selectedEvidence.artifactId} organizationId={organizationId} runId={runId} {...(selectedEvidence.taskId === undefined ? {} : { taskId: selectedEvidence.taskId })} />}<p aria-live="polite">{status}</p></section>;
}
