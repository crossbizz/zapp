'use client';

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';

import { createControlPlaneClient, type MeResponse } from '../../../lib/api';
import { organizationStorageKey, resolveOrganization } from '../../../lib/session';

type BillingStatus = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getBillingStatus']>
>;
type CreditPack = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['listCreditPacks']>
>['packs'][number];

export default function BillingPage(): ReactElement {
  const [profile, setProfile] = useState<MeResponse>();
  const [organizationId, setOrganizationId] = useState<string>();
  const [billing, setBilling] = useState<BillingStatus>();
  const [packs, setPacks] = useState<readonly CreditPack[]>([]);
  const [seats, setSeats] = useState<number | ''>('');
  const [status, setStatus] = useState('');
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
        if (selected === undefined) throw new Error('Join an organization to manage billing.');
        if (selected.role !== 'owner')
          throw new Error('Owner access is required to manage billing.');
        const client = createControlPlaneClient(selected.organization.id);
        const [billingStatus, creditPacks] = await Promise.all([
          client.getBillingStatus(abort.signal),
          client.listCreditPacks(abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setProfile(me);
        setOrganizationId(selected.organization.id);
        setBilling(billingStatus);
        setSeats(billingStatus.billing.seats ?? '');
        setPacks(creditPacks.packs);
      } catch (reason) {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Billing could not be loaded.');
      }
    })();
    return () => {
      abort.abort();
    };
  }, []);

  async function updateSeats(): Promise<void> {
    if (organizationId === undefined) return;
    if (!Number.isInteger(seats) || typeof seats !== 'number') return;
    setStatus('Updating seats…');
    try {
      await createControlPlaneClient(organizationId).updateBillingSeats(seats);
      setStatus('Seat update accepted. Stripe will confirm the change shortly.');
    } catch {
      setStatus('Seats could not be updated.');
    }
  }

  async function openPortal(): Promise<void> {
    if (organizationId === undefined) return;
    setStatus('Opening Stripe…');
    try {
      const response = await createControlPlaneClient(organizationId).createBillingPortal();
      globalThis.open(response.url, '_blank', 'noopener,noreferrer');
      setStatus('Stripe billing portal opened in a new tab.');
    } catch {
      setStatus('The Stripe billing portal could not be opened.');
    }
  }

  async function buyCredits(pack: CreditPack): Promise<void> {
    if (organizationId === undefined) return;
    setStatus('Opening credit checkout…');
    try {
      const response = await createControlPlaneClient(organizationId).createTopupCheckout(pack.id);
      globalThis.open(response.url, '_blank', 'noopener,noreferrer');
      setStatus('Credit checkout opened in a new tab.');
    } catch {
      setStatus('Credit checkout could not be opened.');
    }
  }

  if (error !== undefined)
    return (
      <main style={shellStyle}>
        <h1>Billing</h1>
        <p role="alert">{error}</p>
      </main>
    );
  if (billing === undefined || profile === undefined)
    return (
      <main style={shellStyle}>
        <h1>Billing</h1>
        <p role="status">Loading billing…</p>
      </main>
    );
  const plan = billing.billing.planId.charAt(0).toUpperCase() + billing.billing.planId.slice(1);

  return (
    <main style={shellStyle}>
      <nav aria-label="Organization settings" style={navStyle}>
        <a href="/org/usage">Usage</a>
        <a href="/org/billing" aria-current="page">
          Billing
        </a>
        <a href="/org/audit">Audit log</a>
      </nav>
      <header>
        <p style={eyebrowStyle}>{profile.user.displayName}</p>
        <h1>Billing</h1>
        <p>Manage the organization plan, Stripe payment method, seats, and prepaid credits.</p>
      </header>
      <section aria-labelledby="current-plan" style={cardStyle}>
        <h2 id="current-plan">Current plan</h2>
        <strong style={planStyle}>{plan}</strong>
        <p>Subscription: {billing.billing.subscriptionStatus ?? 'not started'}</p>
        {billing.billing.dunning.state === 'current' ? null : (
          <p role="alert">
            Billing is in {billing.billing.dunning.state}. Open Stripe to resolve the outstanding
            payment.
          </p>
        )}
      </section>
      <section aria-labelledby="seat-management" style={cardStyle}>
        <h2 id="seat-management">Seats</h2>
        <p>
          Set the licensed seat quantity. Stripe confirms the authoritative total after the
          subscription update.
        </p>
        {billing.billing.seats === null ? (
          <p role="status">Seat quantity is unavailable until Stripe synchronization completes.</p>
        ) : null}
        <label style={labelStyle}>
          Seats
          <input
            aria-label="Seats"
            style={controlStyle}
            type="number"
            min={1}
            max={1000}
            value={seats}
            onChange={(event) => {
              setSeats(
                event.currentTarget.value.length === 0 ? '' : event.currentTarget.valueAsNumber,
              );
            }}
          />
        </label>
        <button
          style={buttonStyle}
          type="button"
          onClick={() => void updateSeats()}
          disabled={
            typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1 || seats > 1000
          }
        >
          Update seats
        </button>
      </section>
      <section aria-labelledby="payment-method" style={cardStyle}>
        <h2 id="payment-method">Payment method</h2>
        <p>Payment details remain in Stripe and are never exposed to zapp.build.</p>
        <button style={buttonStyle} type="button" onClick={() => void openPortal()}>
          Manage payment method
        </button>
      </section>
      <section aria-labelledby="credit-topups" style={cardStyle}>
        <h2 id="credit-topups">Top up credits</h2>
        <div style={packGridStyle}>
          {packs.map((pack) => (
            <article key={pack.id} style={packStyle}>
              <strong>{pack.credits} credits</strong>
              <span>${pack.amountUsd}</span>
              <button style={buttonStyle} type="button" onClick={() => void buyCredits(pack)}>
                Buy {pack.credits} credits
              </button>
            </article>
          ))}
        </div>
      </section>
      <p role="status" aria-live="polite">
        {status}
      </p>
    </main>
  );
}

const shellStyle: CSSProperties = {
  maxWidth: 900,
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
};
const planStyle: CSSProperties = {
  display: 'block',
  fontSize: 'var(--zapp-text-32)',
  margin: '8px 0',
};
const labelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginBottom: 12,
};
const controlStyle: CSSProperties = {
  border: '1px solid var(--zapp-border)',
  borderRadius: 8,
  padding: '9px 10px',
  width: 120,
};
const buttonStyle: CSSProperties = {
  border: 0,
  borderRadius: 'var(--zapp-radius-pill)',
  padding: '10px 16px',
  color: 'var(--zapp-text-inverse)',
  background: 'var(--zapp-accent)',
  cursor: 'pointer',
};
const packGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 12,
};
const packStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  border: '1px solid var(--zapp-border)',
  borderRadius: 10,
  padding: 16,
};
