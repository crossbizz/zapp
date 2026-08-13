'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { AppShell } from '../../../components/shell/AppShell';
import { PageFrame } from '../../../components/shell/PageFrame';
import { useAppSession } from '../../../hooks/useAppSession';
import { createControlPlaneClient } from '../../../lib/api';

type BillingStatus = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['getBillingStatus']>
>;
type CreditPack = Awaited<
  ReturnType<ReturnType<typeof createControlPlaneClient>['listCreditPacks']>
>['packs'][number];

export default function BillingPage(): ReactElement {
  const appSession = useAppSession();
  const organizationId = appSession.organizationId;
  const [billing, setBilling] = useState<BillingStatus>();
  const [packs, setPacks] = useState<readonly CreditPack[]>([]);
  const [seats, setSeats] = useState<number | ''>('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    const membership = appSession.membership;
    if (membership === undefined) return;
    const abort = new AbortController();
    void (async () => {
      try {
        if (membership.role !== 'owner')
          throw new Error('Owner access is required to manage billing.');
        const client = createControlPlaneClient(membership.organization.id);
        const [billingStatus, creditPacks] = await Promise.all([
          client.getBillingStatus(abort.signal),
          client.listCreditPacks(abort.signal),
        ]);
        if (abort.signal.aborted) return;
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
  }, [appSession.membership]);

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

  if (appSession.snapshot.status === 'loading')
    return (
      <PageFrame title="Billing"><p className="zapp-page-status" role="status">Loading billing…</p></PageFrame>
    );
  if (appSession.snapshot.status === 'error')
    return (
      <PageFrame title="Billing"><p className="zapp-page-alert" role="alert">Your workspace could not be loaded.</p></PageFrame>
    );
  if (appSession.snapshot.status === 'empty')
    return (
      <PageFrame title="Billing"><p className="zapp-page-alert" role="alert">Join an organization to manage billing.</p></PageFrame>
    );

  const readySession = appSession.snapshot;

  const shellProps = {
    activePath: '/org/billing',
    invalidOrganization: appSession.snapshot.invalidOrganization,
    onSignOut: () => appSession.signOut(readySession.membership.organization.id),
    onSwitchOrganization: appSession.switchOrganization,
    session: readySession,
  } as const;

  if (error !== undefined)
    return (
      <AppShell {...shellProps}>
        <PageFrame title="Billing"><p className="zapp-page-alert" role="alert">{error}</p></PageFrame>
      </AppShell>
    );
  if (billing === undefined)
    return (
      <AppShell {...shellProps}>
        <PageFrame title="Billing"><p className="zapp-page-status" role="status">Loading billing…</p></PageFrame>
      </AppShell>
    );
  const plan = billing.billing.planId.charAt(0).toUpperCase() + billing.billing.planId.slice(1);

  return (
    <AppShell {...shellProps}>
      <PageFrame
        description="Manage the organization plan, Stripe payment method, seats, and prepaid credits."
        eyebrow={readySession.profile.user.displayName}
        title="Billing"
      >
        <nav aria-label="Organization settings" className="zapp-org-nav">
          <a href="/org/usage">Usage</a>
          <a href="/org/billing" aria-current="page">Billing</a>
          <a href="/org/audit">Audit log</a>
        </nav>
        <section aria-labelledby="current-plan" className="zapp-page-card zapp-page-card--emphasis">
        <h2 id="current-plan">Current plan</h2>
        <strong className="zapp-page-metric">{plan}</strong>
        <p>Subscription: {billing.billing.subscriptionStatus ?? 'not started'}</p>
        {billing.billing.dunning.state === 'current' ? null : (
          <p role="alert">
            Billing is in {billing.billing.dunning.state}. Open Stripe to resolve the outstanding
            payment.
          </p>
        )}
        </section>
        <section aria-labelledby="seat-management" className="zapp-page-card">
        <h2 id="seat-management">Seats</h2>
        <p>
          Set the licensed seat quantity. Stripe confirms the authoritative total after the
          subscription update.
        </p>
        {billing.billing.seats === null ? (
          <p role="status">Seat quantity is unavailable until Stripe synchronization completes.</p>
        ) : null}
        <label className="zapp-page-field">
          Seats
          <input
            aria-label="Seats"
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
          className="zapp-page-button--primary"
          type="button"
          onClick={() => void updateSeats()}
          disabled={
            typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1 || seats > 1000
          }
        >
          Update seats
        </button>
        </section>
        <section aria-labelledby="payment-method" className="zapp-page-card">
        <h2 id="payment-method">Payment method</h2>
        <p>Payment details remain in Stripe and are never exposed to zapp.build.</p>
        <button className="zapp-page-button--primary" type="button" onClick={() => void openPortal()}>
          Manage payment method
        </button>
        </section>
        <section aria-labelledby="credit-topups" className="zapp-page-card">
        <h2 id="credit-topups">Top up credits</h2>
        <div className="zapp-page-grid">
          {packs.map((pack) => (
            <article key={pack.id} className="zapp-page-card">
              <strong>{pack.credits} credits</strong>
              <span>${pack.amountUsd}</span>
              <button className="zapp-page-button--primary" type="button" onClick={() => void buyCredits(pack)}>
                Buy {pack.credits} credits
              </button>
            </article>
          ))}
        </div>
        </section>
        <p className="zapp-page-status" role="status" aria-live="polite">
        {status}
        </p>
      </PageFrame>
    </AppShell>
  );
}
