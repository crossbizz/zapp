'use client';

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import {
  createControlPlaneClient,
  type NotificationPreferenceChannels,
  type NotificationPreferenceType,
} from '../../../lib/api';
import { AppShell } from '../../../components/shell/AppShell';
import { PageFrame } from '../../../components/shell/PageFrame';
import { useAppSession } from '../../../hooks/useAppSession';

type UsageResponse = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getUsageSummary']>
>;
type Preference = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getNotificationPreferences']>
>['preferences'][number];

const budgetTypes = ['budget_50', 'budget_80', 'budget_100'] as const;

function monthWindow(): { readonly from: string; readonly to: string } {
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

function label(value: string): string {
  return value.replaceAll('_', ' ');
}

export default function UsagePage(): ReactElement {
  const appSession = useAppSession();
  const organizationId = appSession.organizationId;
  const [usage, setUsage] = useState<UsageResponse>();
  const [preferences, setPreferences] = useState<readonly Preference[]>([]);
  const [preferenceSavePending, setPreferenceSavePending] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState('');
  const billingWindow = useMemo(monthWindow, []);

  useEffect(() => {
    if (organizationId === undefined) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const client = createControlPlaneClient(organizationId);
        const [summary, notificationPreferences] = await Promise.all([
          client.getUsageSummary(billingWindow, abort.signal),
          client.getNotificationPreferences(abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setUsage(summary);
        setPreferences(
          notificationPreferences.preferences.filter((preference) =>
            budgetTypes.includes(preference.type as (typeof budgetTypes)[number]),
          ),
        );
      } catch (reason) {
        if (!abort.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Usage could not be loaded.');
        }
      }
    })();
    return () => {
      abort.abort();
    };
  }, [billingWindow, organizationId]);

  async function updatePreference(
    type: NotificationPreferenceType,
    channel: keyof NotificationPreferenceChannels,
    checked: boolean,
  ): Promise<void> {
    if (organizationId === undefined) return;
    const current = preferences.find((preference) => preference.type === type);
    if (current === undefined) return;
    const body = {
      email: current.email,
      inApp: current.inApp,
      desktopPush: current.desktopPush,
      [channel]: checked,
    };
    setPreferences((items) =>
      items.map((item) => (item.type === type ? { ...item, ...body } : item)),
    );
    setPreferenceSavePending(true);
    setStatus('Saving budget alert…');
    try {
      const response = await createControlPlaneClient(organizationId).setNotificationPreference(
        type,
        body,
      );
      setPreferences((items) =>
        items.map((item) => (item.type === type ? response.preference : item)),
      );
      setStatus('Budget alert saved.');
    } catch {
      setPreferences((items) => items.map((item) => (item.type === type ? current : item)));
      setStatus('Budget alert could not be saved.');
    } finally {
      setPreferenceSavePending(false);
    }
  }

  if (appSession.snapshot.status === 'loading') {
    return (
      <PageFrame title="Usage">
        <p className="zapp-page-status" role="status">Loading usage…</p>
      </PageFrame>
    );
  }
  if (appSession.snapshot.status === 'error') {
    return (
      <PageFrame title="Usage">
        <p className="zapp-page-alert" role="alert">Your workspace could not be loaded.</p>
      </PageFrame>
    );
  }
  if (appSession.snapshot.status === 'empty') {
    return (
      <PageFrame title="Usage">
        <p className="zapp-page-alert" role="alert">Join an organization to view usage.</p>
      </PageFrame>
    );
  }

  const readySession = appSession.snapshot;

  const shellProps = {
    activePath: '/org/usage',
    invalidOrganization: readySession.invalidOrganization,
    onSignOut: () => appSession.signOut(readySession.membership.organization.id),
    onSwitchOrganization: appSession.switchOrganization,
    session: readySession,
  } as const;

  if (error !== undefined) {
    return (
      <AppShell {...shellProps}>
        <PageFrame title="Usage">
          <p className="zapp-page-alert" role="alert">{error}</p>
        </PageFrame>
      </AppShell>
    );
  }
  if (usage === undefined) {
    return (
      <AppShell {...shellProps}>
        <PageFrame title="Usage">
          <p className="zapp-page-status" role="status">Loading usage…</p>
        </PageFrame>
      </AppShell>
    );
  }

  return (
    <AppShell {...shellProps}>
      <PageFrame
        description="Track credit balance, spend, and budget alerts for your organization."
        eyebrow={readySession.profile.user.displayName}
        title="Usage"
      >
        <nav aria-label="Organization settings" className="zapp-org-nav">
          <a href="/org/usage" aria-current="page">Usage</a>
          <a href="/org/billing">Billing</a>
          <a href="/org/audit">Audit log</a>
        </nav>
        <p className="zapp-page-status">
          Current billing month · {new Date(usage.window.from).toLocaleDateString()} –{' '}
          {new Date(usage.window.to).toLocaleDateString()}
        </p>
        <section aria-labelledby="credit-balance" className="zapp-page-card zapp-page-card--emphasis">
        <h2 id="credit-balance">Credit balance</h2>
        <strong className="zapp-page-metric">{usage.credits.available} credits</strong>
        <p>
          {usage.credits.reserved} reserved of {usage.credits.wallet} wallet credits.
        </p>
        {usage.credits.source === 'grace' ? (
          <p role="alert">
            Showing the configured grace balance while the wallet provider is unavailable.
          </p>
        ) : null}
        </section>
        <div className="zapp-page-grid">
        <UsageTable
          heading="By category"
          name="Category"
          rows={usage.usage.byCategory.map((row) => ({
            key: row.category,
            name: label(row.category),
            credits: row.credits,
          }))}
        />
        <UsageTable
          heading="By project"
          name="Project"
          rows={usage.usage.byProject.map((row) => ({
            key: row.projectId ?? 'unattributed',
            name: row.projectId ?? 'Unattributed',
            credits: row.credits,
          }))}
        />
        <UsageTable
          heading="By run"
          name="Run"
          rows={usage.usage.byRun.map((row) => ({
            key: row.runId ?? 'unattributed',
            name: row.runId ?? 'Unattributed',
            credits: row.credits,
          }))}
        />
        </div>
        <section aria-labelledby="budget-alerts" className="zapp-page-card">
        <h2 id="budget-alerts">Budget alerts</h2>
        <p>Choose how you are notified as a run consumes its credit budget.</p>
        {budgetTypes.map((type) => {
          const preference = preferences.find((item) => item.type === type);
          if (preference === undefined) return null;
          const threshold = type.slice('budget_'.length);
          return (
            <fieldset key={type} className="zapp-page-card">
              <legend>{threshold}% used</legend>
              {(['email', 'inApp', 'desktopPush'] as const).map((channel) => (
                <label key={channel} className="zapp-page-field">
                  <input
                    type="checkbox"
                    checked={preference[channel]}
                    disabled={preferenceSavePending}
                    aria-label={`${channel === 'inApp' ? 'In app' : channel === 'desktopPush' ? 'Desktop push' : 'Email'} at ${threshold}%`}
                    onChange={(event) =>
                      void updatePreference(type, channel, event.currentTarget.checked)
                    }
                  />
                  {channel === 'inApp'
                    ? 'In app'
                    : channel === 'desktopPush'
                      ? 'Desktop push'
                      : 'Email'}
                </label>
              ))}
            </fieldset>
          );
        })}
        <p className="zapp-page-status" role="status" aria-live="polite">
          {status}
        </p>
        </section>
      </PageFrame>
    </AppShell>
  );
}

function UsageTable({
  heading,
  name,
  rows,
}: {
  readonly heading: string;
  readonly name: string;
  readonly rows: readonly {
    readonly key: string;
    readonly name: string;
    readonly credits: string;
  }[];
}): ReactElement {
  return (
    <section aria-labelledby={`usage-${heading.replaceAll(' ', '-')}`} className="zapp-page-card">
      <h2 id={`usage-${heading.replaceAll(' ', '-')}`}>{heading}</h2>
      <table className="zapp-page-table">
        <thead>
          <tr>
            <th scope="col">
              {name}
            </th>
            <th scope="col">
              Credits
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td>{row.credits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
