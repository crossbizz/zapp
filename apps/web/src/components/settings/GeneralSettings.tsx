'use client';

import { useState, type ReactElement } from 'react';

import type { ProjectSettingsController } from './useProjectSettings';
import styles from './settings.module.css';

export function GeneralSettings({
  controller,
}: { readonly controller: ProjectSettingsController }): ReactElement {
  const project = controller.projectData?.project;
  const [confirmation, setConfirmation] = useState('');
  if (project === undefined) return <p>Loading general settings…</p>;

  return (
    <section className={styles.section}>
      <div>
        <h2>General</h2>
        <p>Project identity and lifecycle controls.</p>
      </div>
      <dl className={styles.details}>
        <div><dt>Name</dt><dd>{project.name}</dd></div>
        <div><dt>Project slug</dt><dd><code>{project.slug}</code></dd></div>
        <div><dt>Support level</dt><dd>{project.supportLevel}</dd></div>
      </dl>
      {controller.canEditProject && controller.client !== undefined ? (
        <button
          className="zapp-button zapp-button--secondary"
          onClick={() => {
            void controller.run(
              () => controller.client?.updateProject(
                controller.projectId,
                { archived: project.archivedAt === null },
              ) ?? Promise.resolve(),
              project.archivedAt === null ? 'Project archived.' : 'Project restored.',
            );
          }}
          type="button"
        >
          {project.archivedAt === null ? 'Archive project' : 'Restore project'}
        </button>
      ) : <p className={styles.readOnly}>Viewer access is read-only.</p>}

      {controller.isOwner && controller.client !== undefined ? (
        <section className={styles.dangerZone}>
          <h3>Danger zone</h3>
          <label>
            Type {project.name} to delete
            <input
              onChange={(event) => {
                setConfirmation(event.target.value);
              }}
              value={confirmation}
            />
          </label>
          <button
            className="zapp-button zapp-button--danger"
            disabled={confirmation !== project.name}
            onClick={() => {
              void controller.run(
                () => controller.client?.deleteProject(controller.projectId) ?? Promise.resolve(),
                'Project deletion queued. Progress will appear on the project timeline.',
              );
            }}
            type="button"
          >
            Delete project
          </button>
        </section>
      ) : null}
    </section>
  );
}
