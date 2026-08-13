'use client';

import { useState, type ReactElement, type SyntheticEvent } from 'react';

import type { ProjectSettingsController } from './useProjectSettings';
import styles from './settings.module.css';

export function GitHubSettings({
  controller,
}: { readonly controller: ProjectSettingsController }): ReactElement {
  const [installationId, setInstallationId] = useState('');
  const [repositoryName, setRepositoryName] = useState('');
  const github = controller.github;
  const exportRepository = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const saved = await controller.run(
      () => controller.client?.exportToGitHub(controller.projectId, {
        installationId,
        private: true,
        repositoryName,
        syncPolicy: 'pull_request',
      }) ?? Promise.resolve(),
      'GitHub export started.',
    );
    if (saved) {
      setInstallationId('');
      setRepositoryName('');
    }
  };
  return (
    <section className={styles.section}>
      <div><h2>GitHub sync</h2><p>Export code and control repository synchronization.</p></div>
      {github === undefined ? <p>No GitHub repository is connected.</p> : (
        <>
          <p>State: {github.state ?? 'Not synchronized'} · {github.externalRepoRef ?? 'No external repository'}</p>
          {controller.canEditProject && controller.client !== undefined ? (
            <div className={styles.inlineForm}>
              <label>
                Sync policy
                <select
                  onChange={(event) => {
                    void controller.run(
                      () => controller.client?.updateGitHubSyncPolicy(
                        controller.projectId,
                        event.target.value as 'direct_push' | 'pull_request',
                      ) ?? Promise.resolve(),
                      'Sync policy updated.',
                    );
                  }}
                  value={github.syncPolicy}
                >
                  <option value="direct_push">Direct push</option>
                  <option value="pull_request">Pull request</option>
                </select>
              </label>
              <button className="zapp-button zapp-button--secondary" onClick={() => {
                void controller.run(
                  () => controller.client?.syncGitHubNow(controller.projectId) ?? Promise.resolve(),
                  'GitHub sync completed.',
                );
              }} type="button">Sync now</button>
            </div>
          ) : <p className={styles.readOnly}>Viewer access is read-only.</p>}
        </>
      )}
      {controller.isOwner && controller.client !== undefined ? (
        <form className={styles.formGrid} onSubmit={(event) => {
          void exportRepository(event);
        }}>
          <h3>Export to GitHub</h3>
          <label>Installation ID<input onChange={(event) => {
            setInstallationId(event.target.value);
          }} required value={installationId} /></label>
          <label>Repository name<input onChange={(event) => {
            setRepositoryName(event.target.value);
          }} required value={repositoryName} /></label>
          <button className="zapp-button zapp-button--primary" type="submit">Export to GitHub</button>
        </form>
      ) : null}
    </section>
  );
}
