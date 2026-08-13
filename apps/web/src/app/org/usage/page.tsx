'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react';

import {
  createControlPlaneClient,
  type MeResponse,
  type NotificationPreferenceChannels,
  type NotificationPreferenceType,
} from '../../../lib/api';
import { organizationStorageKey, resolveOrganization } from '../../../lib/session';

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
  const [profile, setProfile] = useState<MeResponse>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [usage, setUsage] = useState<UsageResponse>();
  const [preferences, setPreferences] = useState<readonly Preference[]>([]);
  const [preferenceSavePending, setPreferenceSavePending] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState('');
  const window = useMemo(monthWindow, []);

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
        if (selected === undefined) throw new Error('Join an organization to view usage.');
        const client = createControlPlaneClient(selected.organization.id);
        const [summary, notificationPreferences] = await Promise.all([
          client.getUsageSummary(window, abort.signal),
          client.getNotificationPreferences(abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setProfile(me);
        setOrganizationId(selected.organization.id);
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
  }, [window]);

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

  if (error !== undefined) {
    return (
      <main style={shellStyle}>
        <h1>Usage</h1>
        <p role="alert">{error}</p>
      </main>
    );
  }
  if (usage === undefined || profile === undefined) {
    return (
      <main style={shellStyle}>
        <h1>Usage</h1>
        <p role="status">Loading usage…</p>
      </main>
    );
  }

  return (
    <main style={shellStyle}>
      <nav aria-label="Organization settings" style={navStyle}>
        <a href="/org/usage" aria-current="page">
          Usage
        </a>
        <a href="/org/billing">Billing</a>
        <a href="/org/audit">Audit log</a>
      </nav>
      <header>
        <p style={eyebrowStyle}>{profile.user.displayName}</p>
        <h1>Usage</h1>
        <p>
          Current billing month · {new Date(usage.window.from).toLocaleDateString()} –{' '}
          {new Date(usage.window.to).toLocaleDateString()}
        </p>
      </header>
      <section aria-labelledby="credit-balance" style={cardStyle}>
        <h2 id="credit-balance">Credit balance</h2>
        <strong style={balanceStyle}>{usage.credits.available} credits</strong>
        <p>
          {usage.credits.reserved} reserved of {usage.credits.wallet} wallet credits.
        </p>
        {usage.credits.source === 'grace' ? (
          <p role="alert">
            Showing the configured grace balance while the wallet provider is unavailable.
          </p>
        ) : null}
      </section>
      <div style={gridStyle}>
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
      <section aria-labelledby="budget-alerts" style={cardStyle}>
        <h2 id="budget-alerts">Budget alerts</h2>
        <p>Choose how you are notified as a run consumes its credit budget.</p>
        {budgetTypes.map((type) => {
          const preference = preferences.find((item) => item.type === type);
          if (preference === undefined) return null;
          const threshold = type.slice('budget_'.length);
          return (
            <fieldset key={type} style={fieldsetStyle}>
              <legend>{threshold}% used</legend>
              {(['email', 'inApp', 'desktopPush'] as const).map((channel) => (
                <label key={channel} style={checkStyle}>
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
        <p role="status" aria-live="polite">
          {status}
        </p>
      </section>
    </main>
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
    <section aria-labelledby={`usage-${heading.replaceAll(' ', '-')}`} style={cardStyle}>
      <h2 id={`usage-${heading.replaceAll(' ', '-')}`}>{heading}</h2>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th scope="col" style={cellStyle}>
              {name}
            </th>
            <th scope="col" style={cellStyle}>
              Credits
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td style={cellStyle}>{row.name}</td>
              <td style={cellStyle}>{row.credits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
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
const cardStyle: CSSProperties = {
  border: '1px solid var(--zapp-border)',
  borderRadius: 'var(--zapp-radius-panel)',
  background: 'var(--zapp-surface-raised)',
  padding: 20,
  marginTop: 20,
  overflowX: 'auto',
};
const balanceStyle: CSSProperties = {
  display: 'block',
  fontSize: 'var(--zapp-text-32)',
  margin: '8px 0',
};
const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 16,
};
const tableStyle: CSSProperties = { borderCollapse: 'collapse', width: '100%' };
const cellStyle: CSSProperties = {
  borderBottom: '1px solid var(--zapp-border)',
  padding: '10px 8px',
  textAlign: 'left',
};
const fieldsetStyle: CSSProperties = {
  border: '1px solid var(--zapp-border)',
  marginTop: 12,
  padding: 12,
};
const checkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  marginRight: 20,
};
