'use client';

import { Button } from '@zapp/ui';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type BuilderRun, type ProjectIncident } from '../../lib/api';

interface IncidentBannerProps {
  readonly organizationId: string;
  readonly projectId: string;
  readonly onRunCreated: (run: BuilderRun) => void;
}

export function IncidentBanner({
  organizationId,
  projectId,
  onRunCreated,
}: IncidentBannerProps): ReactElement | null {
  const client = useMemo(() => createControlPlaneClient(organizationId), [organizationId]);
  const [incident, setIncident] = useState<ProjectIncident>();
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .listIncidents(projectId, { limit: 50 }, controller.signal)
      .then((page) => {
        const requested = new URLSearchParams(window.location.search).get('incident');
        const active = page.items.filter((item) => item.status !== 'resolved');
        setIncident(
          (requested === null ? undefined : active.find((item) => item.id === requested)) ??
            active[0],
        );
      })
      .catch(() => {
        // Incident availability must not take down the builder surface.
      });
    return () => {
      controller.abort();
    };
  }, [client, projectId]);

  if (incident === undefined) return null;

  const createFixRun = async (): Promise<void> => {
    setStarting(true);
    setFailed(false);
    try {
      const response = await client.createRun(projectId, {
        mode: 'fix',
        prompt: `Fix production incident: ${incident.title}`,
        fixRequest: incident.fixRequest,
      });
      onRunCreated(response.run);
      setStarted(true);
      setIncident((current) =>
        current === undefined
          ? current
          : { ...current, fixRunId: response.run.id, status: 'fix_running' },
      );
    } catch {
      setFailed(true);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="zapp-incident-banner" aria-labelledby={`incident-${incident.id}`}>
      <style jsx>{`
        .zapp-incident-banner {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.75rem 1rem;
          border-bottom: 1px solid var(--zapp-border);
          color: var(--zapp-text-primary);
          background: var(--zapp-danger-surface);
        }

        .zapp-incident-copy {
          min-width: 0;
        }

        .zapp-incident-copy h2,
        .zapp-incident-copy p {
          margin: 0;
        }

        .zapp-incident-copy h2 {
          font-size: var(--zapp-text-16);
        }

        .zapp-incident-copy p {
          margin-top: 0.25rem;
          color: var(--zapp-text-muted);
          font-size: var(--zapp-text-14);
        }

        .zapp-incident-actions {
          display: flex;
          flex: 0 0 auto;
          align-items: center;
          gap: 0.75rem;
        }

        @media (max-width: 48rem) {
          .zapp-incident-banner {
            align-items: stretch;
            flex-direction: column;
          }
        }
      `}</style>
      <div className="zapp-incident-copy">
        <h2 id={`incident-${incident.id}`}>{incident.title}</h2>
        <p>
          Release {incident.releaseId} · Reproduce at {incident.reproductionRoute}
        </p>
      </div>
      <div className="zapp-incident-actions">
        {started || incident.fixRunId !== null ? <span role="status">Fix run started</span> : null}
        {failed ? <span role="alert">Fix run could not be started.</span> : null}
        {incident.fixRunId === null ? (
          <Button disabled={starting} onClick={() => void createFixRun()} variant="primary">
            {starting ? 'Starting…' : 'Create Fix run'}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
