'use client';

import { useState, type ReactElement, type SyntheticEvent } from 'react';

import type { ProjectSettingsController } from './useProjectSettings';
import styles from './settings.module.css';

function RotateSecret({
  controller,
  secretId,
}: {
  readonly controller: ProjectSettingsController;
  readonly secretId: string;
}): ReactElement {
  const [value, setValue] = useState('');
  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    try {
      await controller.run(
        () => controller.client?.rotateProjectSecret(controller.projectId, secretId, value)
          ?? Promise.resolve(),
        'Secret rotated.',
      );
    } finally {
      setValue('');
    }
  };
  return (
    <form className={styles.inlineForm} onSubmit={(event) => {
      void submit(event);
    }}>
      <input
        aria-label={`New value for ${secretId}`}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        placeholder="New value"
        required
        type="password"
        value={value}
      />
      <button className="zapp-button zapp-button--secondary" type="submit">Rotate</button>
    </form>
  );
}

export function SecretsSettings({
  controller,
}: { readonly controller: ProjectSettingsController }): ReactElement {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    try {
      const saved = await controller.run(
        () => controller.client?.createProjectSecret(controller.projectId, {
          name,
          value,
          ...(environmentId === '' ? {} : { environmentId }),
        }) ?? Promise.resolve(),
        'Secret added.',
      );
      if (saved) setName('');
    } finally {
      setValue('');
    }
  };

  return (
    <section className={styles.section}>
      <div>
        <h2>Secrets</h2>
        <p>Values are write-only. Saved secrets expose metadata only.</p>
      </div>
      {controller.canEditProject && controller.client !== undefined ? (
        <form className={styles.formGrid} onSubmit={(event) => {
          void submit(event);
        }}>
          <label>Name<input onChange={(event) => {
            setName(event.target.value);
          }} required value={name} /></label>
          <label>
            Value
            <input
              aria-label="Secret value"
              onChange={(event) => {
                setValue(event.target.value);
              }}
              required
              type="password"
              value={value}
            />
          </label>
          <label>
            Environment
            <select onChange={(event) => {
              setEnvironmentId(event.target.value);
            }} value={environmentId}>
              <option value="">All environments</option>
              {controller.projectData?.environments.map((environment) => (
                <option key={environment.id} value={environment.id}>{environment.name}</option>
              ))}
            </select>
          </label>
          <button className="zapp-button zapp-button--primary" type="submit">Add secret</button>
        </form>
      ) : <p className={styles.readOnly}>Viewer access is read-only.</p>}
      <ul className={styles.itemList}>
        {controller.secrets?.items.map((secret) => (
          <li key={secret.id}>
            <div>
              <strong>{secret.name}</strong>
              <small>{secret.environmentId === null ? 'All environments' : secret.environmentId} · version {secret.keyVersion}</small>
            </div>
            {controller.canEditProject && controller.client !== undefined
              ? <RotateSecret controller={controller} secretId={secret.id} />
              : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
