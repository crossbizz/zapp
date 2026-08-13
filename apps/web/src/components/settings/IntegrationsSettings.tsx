import type { ReactElement } from 'react';

import { INTEGRATION_CATALOG } from './integration-catalog';
import { IntegrationConnectDialog } from './IntegrationConnectDialog';
import type { IntegrationCatalogEntry } from './settings-types';
import type { ProjectSettingsController } from './useProjectSettings';
import styles from './settings.module.css';

export interface IntegrationsSettingsProps {
  readonly controller: ProjectSettingsController;
  readonly entries?: readonly IntegrationCatalogEntry[];
  readonly heading?: string;
}

export function IntegrationsSettings({
  controller,
  entries = INTEGRATION_CATALOG,
  heading = 'Integrations',
}: IntegrationsSettingsProps): ReactElement {
  return (
    <section className={styles.section}>
      <div>
        <h2>{heading}</h2>
        <p>Connect supported services through tenant-scoped public APIs.</p>
      </div>
      {!controller.isOwner ? <p className={styles.readOnly}>Only Owners can manage integrations.</p> : (
        <div className={styles.integrationGrid}>
          {entries.map((entry) => {
            const connection = controller.integrations?.connections.find((item) => (
              item.provider === entry.provider
              && (item.projectId === null || item.projectId === controller.projectId)
            ));
            return (
              <article className={styles.integrationCard} key={entry.provider}>
                <div className={styles.integrationIdentity}>
                  <span aria-hidden="true" className={styles.integrationMark}>
                    {entry.title.slice(0, 1)}
                  </span>
                  <div><h3>{entry.title}</h3><p>{entry.description}</p></div>
                </div>
                <p className={styles.connectionStatus} data-connected={connection !== undefined}>
                  {connection === undefined ? 'Not connected' : 'Connected'}
                </p>
                {connection === undefined ? (
                  <IntegrationConnectDialog controller={controller} entry={entry} />
                ) : (
                  <button
                    className="zapp-button zapp-button--secondary"
                    onClick={() => void controller.run(
                      () => controller.client?.disconnectIntegration(connection.id)
                        ?? Promise.resolve(),
                      `${entry.title} disconnected.`,
                    )}
                    type="button"
                  >
                    Disconnect
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
