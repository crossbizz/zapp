'use client';

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';

import { createControlPlaneClient, type AuditEventsQuery, type MeResponse } from '../../../lib/api';
import { organizationStorageKey, resolveOrganization } from '../../../lib/session';

type AuditPage = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['listAuditEvents']>
>;
type AuditAction = NonNullable<AuditEventsQuery>['action'];

const actions: readonly NonNullable<AuditAction>[] = [
  'organization.updated',
  'member.invited',
  'member.role_changed',
  'project.created',
  'project.updated',
  'run.created',
  'release.created',
  'release.deploy_requested',
  'secret.created',
];

export default function AuditPageComponent(): ReactElement {
  const [profile, setProfile] = useState<MeResponse>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [owner, setOwner] = useState<boolean>();
  const [page, setPage] = useState<AuditPage>();
  const [action, setAction] = useState<AuditAction>();
  const [actorId, setActorId] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const me = await createControlPlaneClient().getMe();
        const override = new URL(globalThis.location.href).searchParams.get('organization');
        const selected = resolveOrganization(
          me.memberships,
          override,
          localStorage.getItem(organizationStorageKey(me.user.id)),
        ).membership;
        if (selected === undefined) throw new Error('Join an organization to view its audit log.');
        setProfile(me);
        setOrganizationId(selected.organization.id);
        setOwner(selected.role === 'owner');
        if (selected.role !== 'owner') return;
        const response = await createControlPlaneClient(selected.organization.id).listAuditEvents(
          selected.organization.id,
          {},
          abort.signal,
        );
        if (!abort.signal.aborted) setPage(response);
      } catch (reason) {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'The audit log could not be loaded.');
      }
    })();
    return () => {
      abort.abort();
    };
  }, []);

  useEffect(() => {
    if (
      owner !== true ||
      organizationId === undefined ||
      page === undefined ||
      (action === undefined && actorId.trim().length === 0)
    )
      return;
    const abort = new AbortController();
    const query: AuditEventsQuery = {
      ...(action === undefined ? {} : { action }),
      ...(actorId.trim().length === 0 ? {} : { actorId: actorId.trim() }),
    };
    void createControlPlaneClient(organizationId)
      .listAuditEvents(organizationId, query, abort.signal)
      .then((response) => {
        setPage(response);
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'The audit filter failed.');
      });
    return () => {
      abort.abort();
    };
  }, [action, actorId, organizationId, owner]);

  if (error !== undefined)
    return (
      <main style={shellStyle}>
        <h1>Audit log</h1>
        <p role="alert">{error}</p>
      </main>
    );
  if (owner === false)
    return (
      <main style={shellStyle}>
        <h1>Owner access required</h1>
        <p>Only organization Owners can view audit events.</p>
      </main>
    );
  if (page === undefined || profile === undefined)
    return (
      <main style={shellStyle}>
        <h1>Audit log</h1>
        <p role="status">Loading audit log…</p>
      </main>
    );

  return (
    <main style={shellStyle}>
      <nav aria-label="Organization settings" style={navStyle}>
        <a href="/org/usage">Usage</a>
        <a href="/org/billing">Billing</a>
        <a href="/org/audit" aria-current="page">
          Audit log
        </a>
      </nav>
      <header>
        <p style={eyebrowStyle}>{profile.user.displayName}</p>
        <h1>Audit log</h1>
        <p>Immutable organization activity, newest first.</p>
      </header>
      <form
        aria-label="Audit filters"
        style={filterStyle}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label style={labelStyle}>
          Action
          <select
            aria-label="Action"
            style={controlStyle}
            value={action ?? ''}
            onChange={(event) => {
              setAction(
                event.currentTarget.value === ''
                  ? undefined
                  : (event.currentTarget.value as NonNullable<AuditAction>),
              );
            }}
          >
            <option value="">All actions</option>
            {actions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Actor ID
          <input
            style={controlStyle}
            value={actorId}
            onChange={(event) => {
              setActorId(event.currentTarget.value);
            }}
          />
        </label>
      </form>
      <section aria-label="Audit events" style={cardStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th scope="col" style={cellStyle}>
                Time
              </th>
              <th scope="col" style={cellStyle}>
                Action
              </th>
              <th scope="col" style={cellStyle}>
                Actor
              </th>
              <th scope="col" style={cellStyle}>
                Target
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((event) => (
              <tr key={event.id}>
                <td style={cellStyle}>{new Date(event.occurredAt).toLocaleString()}</td>
                <td style={cellStyle}>{event.action}</td>
                <td style={cellStyle}>
                  {event.actorType}: {event.actorId}
                </td>
                <td style={cellStyle}>
                  {event.targetType}
                  {event.targetId === null ? '' : `: ${event.targetId}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {page.items.length === 0 ? <p>No audit events match these filters.</p> : null}
      </section>
    </main>
  );
}

const shellStyle: CSSProperties = {
  maxWidth: 1120,
  margin: '0 auto',
  minHeight: '100vh',
  padding: '32px 24px',
  color: 'var(--zapp-text-primary)',
  background: 'var(--zapp-surface-subtle)',
  fontFamily: 'var(--zapp-font-sans)',
};
const navStyle: CSSProperties = { display: 'flex', gap: 20, marginBottom: 32 };
const eyebrowStyle: CSSProperties = { color: 'var(--zapp-text-muted)', marginBottom: 4 };
const filterStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 16, margin: '20px 0' };
const labelStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
const controlStyle: CSSProperties = {
  minWidth: 230,
  border: '1px solid var(--zapp-border)',
  borderRadius: 8,
  padding: '9px 10px',
  background: 'var(--zapp-surface-raised)',
  color: 'var(--zapp-text-primary)',
};
const cardStyle: CSSProperties = {
  border: '1px solid var(--zapp-border)',
  borderRadius: 'var(--zapp-radius-panel)',
  background: 'var(--zapp-surface-raised)',
  padding: 20,
  overflowX: 'auto',
};
const tableStyle: CSSProperties = { borderCollapse: 'collapse', width: '100%' };
const cellStyle: CSSProperties = {
  borderBottom: '1px solid var(--zapp-border)',
  padding: '10px 8px',
  textAlign: 'left',
  verticalAlign: 'top',
};
