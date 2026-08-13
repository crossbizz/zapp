'use client';

import { Dialog } from '@zapp/ui';
import { useRef, useState, type ReactElement, type SyntheticEvent } from 'react';

import type { IntegrationCatalogEntry } from './settings-types';
import type { ProjectSettingsController } from './useProjectSettings';
import styles from './settings.module.css';

function operationKey(): string {
  return crypto.randomUUID();
}

export interface IntegrationConnectDialogProps {
  readonly controller: ProjectSettingsController;
  readonly entry: IntegrationCatalogEntry;
}

export function IntegrationConnectDialog({
  controller,
  entry,
}: IntegrationConnectDialogProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const key = useRef(operationKey());
  const clearCredentials = (): void => {
    setValues({});
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const client = controller.client;
    if (client === undefined) return;
    try {
      const saved = await controller.run(async () => {
        switch (entry.provider) {
          case 'github': {
            const response = await client.authorizeGitHubInstall(key.current);
            globalThis.location.assign(response.url);
            return response;
          }
          case 'supabase':
            return await client.connectSupabase(
              controller.projectId,
              values['accessToken'] ?? '',
              values['projectRef'] ?? '',
              key.current,
            );
          case 'neon':
            return await client.connectNeon(
              controller.projectId,
              values['apiKey'] ?? '',
              values['projectId'] ?? '',
              values['databaseName'] ?? '',
              key.current,
            );
          case 'stripe':
            return await client.connectStripe(
              controller.projectId,
              values['apiKey'] ?? '',
              values['accountId'] ?? '',
              key.current,
            );
          case 'vercel':
            return await client.connectVercel(
              controller.projectId,
              values['accessToken'] ?? '',
              values['projectId'] ?? '',
              values['projectName'] ?? '',
              key.current,
            );
        }
      }, `${entry.title} connected.`);
      if (saved) setOpen(false);
    } finally {
      clearCredentials();
    }
  };

  return (
    <Dialog
      description={entry.description}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) key.current = operationKey();
        else clearCredentials();
      }}
      open={open}
      title={`Connect ${entry.title}`}
      trigger={<button className="zapp-button zapp-button--secondary" type="button">Connect</button>}
    >
      <form className={styles.connectForm} onSubmit={(event) => {
        void submit(event);
      }}>
        {entry.fields.map((field) => (
          <label key={field.id}>
            {field.label}
            <input
              aria-label={`${entry.provider} ${field.label.toLowerCase()}`}
              autoComplete="off"
              onChange={(event) => {
                key.current = operationKey();
                setValues((current) => ({ ...current, [field.id]: event.target.value }));
              }}
              placeholder={field.placeholder}
              required
              type={field.secret ? 'password' : 'text'}
              value={values[field.id] ?? ''}
            />
          </label>
        ))}
        {entry.provider === 'github' ? <p>You will continue to GitHub to choose an installation.</p> : null}
        <button className="zapp-button zapp-button--primary" type="submit">
          {entry.provider === 'github' ? 'Continue to GitHub' : `Connect ${entry.title}`}
        </button>
      </form>
    </Dialog>
  );
}
