'use client';

import { ZappApiError } from '@zapp/api-client';
import { Button, Card } from '@zapp/ui';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { createControlPlaneClient } from '../../lib/api';
import styles from './admin.module.css';

type AdminClient = ReturnType<typeof createControlPlaneClient>;
type SupportSession = Awaited<ReturnType<AdminClient['startSupportSession']>>;
type Overview = Awaited<ReturnType<AdminClient['getAdminOverview']>>;
type Diagnostics = Awaited<ReturnType<AdminClient['getAdminRunDiagnostics']>>;

function supportWindow(): { readonly from: string; readonly to: string } {
  const to = new Date();
  return {
    from: new Date(to.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
    to: to.toISOString(),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ZappApiError && error.status === 403) {
    return 'Staff access is not available for this account.';
  }
  if (error instanceof ZappApiError && error.status === 422) {
    return 'Enter an explicit support reason before starting a session.';
  }
  return 'The support action failed. Retry with the same reason and customer.';
}

export function AdminConsole(): ReactElement {
  const [organizationId, setOrganizationId] = useState('');
  const [reason, setReason] = useState('');
  const [session, setSession] = useState<SupportSession>();
  const [overview, setOverview] = useState<Overview>();
  const [diagnostics, setDiagnostics] = useState<Diagnostics>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function startSession(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    setOverview(undefined);
    setDiagnostics(undefined);
    try {
      const client = createControlPlaneClient();
      const created = await client.startSupportSession({ organizationId, reason });
      const loaded = await client.getAdminOverview(
        organizationId,
        supportWindow(),
        created.token,
      );
      setSession(created);
      setOverview(loaded);
    } catch (caught) {
      setSession(undefined);
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  async function inspectRun(runId: string): Promise<void> {
    if (session === undefined) return;
    setPending(true);
    setError(undefined);
    try {
      const client = createControlPlaneClient();
      setDiagnostics(
        await client.getAdminRunDiagnostics(organizationId, runId, session.token),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  async function terminateRun(runId: string): Promise<void> {
    if (
      session === undefined ||
      !window.confirm(`Terminate run ${runId}? This action is audited.`)
    ) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const client = createControlPlaneClient();
      await client.terminateAdminRun(organizationId, runId, session.token);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  async function terminateWorkspace(workspaceId: string): Promise<void> {
    if (
      session === undefined ||
      !window.confirm(`Terminate workspace ${workspaceId}? This action is audited.`)
    ) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const client = createControlPlaneClient();
      await client.terminateAdminWorkspace(organizationId, workspaceId, session.token);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  async function terminateAllSandboxes(): Promise<void> {
    if (
      session === undefined ||
      !window.confirm('Terminate every active sandbox for this customer? This action is audited.')
    ) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const client = createControlPlaneClient();
      const result = await client.terminateAdminOrganizationSandboxes(
        organizationId,
        session.token,
      );
      setNotice(`Terminated ${String(result.terminated)} sandboxes.`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className={styles.console}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Staff only</p>
        <h1>Support console</h1>
        <p>Every customer access and resource action is recorded in the customer audit log.</p>
      </header>

      <Card as="section" className={styles.accessCard}>
        <h2>Start audited support session</h2>
        <form className={styles.form} onSubmit={(event) => void startSession(event)}>
          <label>
            Customer organization ID
            <input
              autoComplete="off"
              onChange={(event) => {
                setOrganizationId(event.target.value);
              }}
              required
              value={organizationId}
            />
          </label>
          <label>
            Support reason
            <textarea
              maxLength={500}
              minLength={10}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              required
              rows={3}
              value={reason}
            />
          </label>
          <Button
            disabled={pending || organizationId.trim() === '' || reason.trim().length < 10}
            type="submit"
          >
            {pending ? 'Starting…' : 'Start support session'}
          </Button>
        </form>
      </Card>

      {error === undefined ? null : (
        <section className="zapp-state zapp-error-state" role="alert">
          <h2 className="zapp-state__title">Support action unavailable</h2>
          <p className="zapp-state__description">{error}</p>
        </section>
      )}
      {notice === undefined ? null : <p className={styles.notice}>{notice}</p>}

      {overview === undefined ? null : (
        <section className={styles.results}>
          <div className={styles.customerHeading}>
            <div>
              <p className={styles.eyebrow}>Customer tenant</p>
              <h2>{overview.organization.name}</h2>
            </div>
            <div className={styles.emergencyActions}>
              <p>Session expires {new Date(session?.expiresAt ?? '').toLocaleString()}</p>
              <Button disabled={pending} onClick={() => void terminateAllSandboxes()}>
                Terminate all sandboxes
              </Button>
            </div>
          </div>
          <p className={styles.boundary}>
            Source inspection is unavailable without a customer grant. Credential values are not
            exposed by this console.
          </p>
          <Card as="section" className={styles.usageCard}>
            <h3>Usage — last 30 days</h3>
            {overview.usage.byCategory.map((item) => (
              <p key={item.category}>
                {item.category}: {item.quantity}
              </p>
            ))}
          </Card>
          <div className={styles.projectGrid}>
            {overview.projects.map((project) => (
              <Card as="article" className={styles.projectCard} key={project.id}>
                <div>
                  <h3>{project.name}</h3>
                  <p>
                    Release {project.releaseStatus ?? 'unknown'} · Deployment{' '}
                    {project.deploymentStatus ?? 'unknown'}
                  </p>
                </div>
                <section>
                  <h4>Runs</h4>
                  {project.runs.map((run) => (
                    <div className={styles.resource} key={run.id}>
                      <code>{run.id}</code>
                      <span>{run.status}</span>
                      <div className={styles.actions}>
                        <Button
                          disabled={pending}
                          onClick={() => void inspectRun(run.id)}
                          variant="secondary"
                        >
                          Inspect {run.id}
                        </Button>
                        <Button disabled={pending} onClick={() => void terminateRun(run.id)}>
                          Terminate {run.id}
                        </Button>
                      </div>
                    </div>
                  ))}
                </section>
                <section>
                  <h4>Sandboxes</h4>
                  {project.workspaces.map((workspace) => (
                    <div className={styles.resource} key={workspace.id}>
                      <code>{workspace.id}</code>
                      <span>
                        {workspace.status} · {workspace.resourceProfile}
                      </span>
                      <Button
                        disabled={pending}
                        onClick={() => void terminateWorkspace(workspace.id)}
                      >
                        Terminate {workspace.id}
                      </Button>
                    </div>
                  ))}
                </section>
              </Card>
            ))}
          </div>
        </section>
      )}

      {diagnostics === undefined ? null : (
        <Card as="section" className={styles.diagnostics}>
          <h2>Run diagnostics</h2>
          <h3>Support events</h3>
          {diagnostics.events.map((event) => (
            <article key={event.id}>
              <strong>{event.type}</strong>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </article>
          ))}
          <h3>Artifact metadata</h3>
          {diagnostics.artifacts.map((artifact) => (
            <p key={artifact.id}>
              {artifact.type} · {artifact.contentHash}
            </p>
          ))}
        </Card>
      )}
    </main>
  );
}
