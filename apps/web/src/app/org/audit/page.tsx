'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { AppShell } from '../../../components/shell/AppShell';
import { PageFrame } from '../../../components/shell/PageFrame';
import { useAppSession } from '../../../hooks/useAppSession';
import { createControlPlaneClient, type AuditEventsQuery } from '../../../lib/api';

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
  const appSession = useAppSession();
  const organizationId = appSession.organizationId;
  const owner = appSession.membership?.role === 'owner';
  const [page, setPage] = useState<AuditPage>();
  const [action, setAction] = useState<AuditAction>();
  const [actorId, setActorId] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    const membership = appSession.membership;
    if (membership === undefined) return;
    const abort = new AbortController();
    void (async () => {
      try {
        if (membership.role !== 'owner') return;
        const selectedOrganizationId = membership.organization.id;
        const response = await createControlPlaneClient(selectedOrganizationId).listAuditEvents(
          selectedOrganizationId,
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
  }, [appSession.membership]);

  useEffect(() => {
    if (
      !owner ||
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

  if (appSession.snapshot.status === 'loading')
    return (
      <PageFrame title="Audit log"><p className="zapp-page-status" role="status">Loading audit log…</p></PageFrame>
    );
  if (appSession.snapshot.status === 'error')
    return (
      <PageFrame title="Audit log"><p className="zapp-page-alert" role="alert">Your workspace could not be loaded.</p></PageFrame>
    );
  if (appSession.snapshot.status === 'empty')
    return (
      <PageFrame title="Audit log"><p className="zapp-page-alert" role="alert">Join an organization to view its audit log.</p></PageFrame>
    );

  const readySession = appSession.snapshot;

  const shellProps = {
    activePath: '/org/audit',
    invalidOrganization: appSession.snapshot.invalidOrganization,
    onSignOut: () => appSession.signOut(readySession.membership.organization.id),
    onSwitchOrganization: appSession.switchOrganization,
    session: readySession,
  } as const;

  if (error !== undefined)
    return (
      <AppShell {...shellProps}>
        <PageFrame title="Audit log"><p className="zapp-page-alert" role="alert">{error}</p></PageFrame>
      </AppShell>
    );
  if (!owner)
    return (
      <AppShell {...shellProps}>
        <PageFrame
          description="Only organization Owners can view audit events."
          title="Owner access required"
        >
          <nav aria-label="Organization settings" className="zapp-org-nav">
            <a href="/org/usage">Usage</a>
            <a href="/org/billing">Billing</a>
            <a href="/org/audit" aria-current="page">Audit log</a>
          </nav>
        </PageFrame>
      </AppShell>
    );
  if (page === undefined)
    return (
      <AppShell {...shellProps}>
        <PageFrame title="Audit log"><p className="zapp-page-status" role="status">Loading audit log…</p></PageFrame>
      </AppShell>
    );

  return (
    <AppShell {...shellProps}>
      <PageFrame
        description="Immutable organization activity, newest first."
        eyebrow={readySession.profile.user.displayName}
        title="Audit log"
      >
        <nav aria-label="Organization settings" className="zapp-org-nav">
          <a href="/org/usage">Usage</a>
          <a href="/org/billing">Billing</a>
          <a href="/org/audit" aria-current="page">Audit log</a>
        </nav>
      <form
        aria-label="Audit filters"
        className="zapp-page-form-row"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="zapp-page-field">
          Action
          <select
            aria-label="Action"
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
        <label className="zapp-page-field">
          Actor ID
          <input
            value={actorId}
            onChange={(event) => {
              setActorId(event.currentTarget.value);
            }}
          />
        </label>
      </form>
        <section aria-label="Audit events" className="zapp-page-card">
        <table className="zapp-page-table">
          <thead>
            <tr>
              <th scope="col">
                Time
              </th>
              <th scope="col">
                Action
              </th>
              <th scope="col">
                Actor
              </th>
              <th scope="col">
                Target
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.occurredAt).toLocaleString()}</td>
                <td>{event.action}</td>
                <td>
                  {event.actorType}: {event.actorId}
                </td>
                <td>
                  {event.targetType}
                  {event.targetId === null ? '' : `: ${event.targetId}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {page.items.length === 0 ? <p>No audit events match these filters.</p> : null}
        </section>
      </PageFrame>
    </AppShell>
  );
}
