import Link from 'next/link';
import type { ReactElement } from 'react';

import { INTEGRATION_CATALOG } from './integration-catalog';
import { IntegrationsSettings } from './IntegrationsSettings';
import type { ProjectSettingsController } from './useProjectSettings';
import styles from './settings.module.css';

const stripeEntry = INTEGRATION_CATALOG.filter((entry) => entry.provider === 'stripe');

export function PaymentsSettings({
  controller,
}: { readonly controller: ProjectSettingsController }): ReactElement {
  return (
    <div className={styles.paymentStack}>
      <IntegrationsSettings
        controller={controller}
        entries={stripeEntry}
        heading="Application payments"
      />
      <aside className={styles.accountBillingCallout}>
        <h3>zapp.build account billing</h3>
        <p>Manage your zapp.build plan, seats, credits, and invoices separately.</p>
        <Link href="/org/billing">Open account Billing</Link>
      </aside>
    </div>
  );
}
