'use client';

import { Button, Dialog } from '@zapp/ui';
import { useEffect, useState, type ReactElement } from 'react';

import styles from './projects.module.css';

export interface DeleteProjectDialogProps {
  readonly busy: boolean;
  readonly error?: string | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly projectName: string;
  readonly returnFocusElement?: HTMLElement | null | undefined;
}

export function DeleteProjectDialog({
  busy,
  error,
  onCancel,
  onConfirm,
  open,
  projectName,
  returnFocusElement,
}: DeleteProjectDialogProps): ReactElement {
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => {
    setConfirmation('');
  }, [open, projectName]);

  return (
    <Dialog
      className={styles.deleteProjectDialog ?? ''}
      description="This permanently removes the project, its source, previews, and deployment history."
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        returnFocusElement?.focus();
      }}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
      open={open}
      title={`Delete ${projectName}`}
      trigger={
        <button
          aria-hidden="true"
          className={styles.deleteDialogTrigger ?? ''}
          tabIndex={-1}
          type="button"
        />
      }
    >
      <form
        className={styles.deleteProjectForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmation === projectName && !busy) onConfirm();
        }}
      >
        <p>
          Type <strong>{projectName}</strong> to confirm.
        </p>
        <label className={styles.deleteProjectField}>
          <span>Project name</span>
          <input
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
            value={confirmation}
          />
        </label>
        {error === undefined ? null : <p role="alert">{error}</p>}
        <div className={styles.deleteProjectActions}>
          <Button disabled={busy} onClick={onCancel} variant="secondary">
            Cancel
          </Button>
          <Button disabled={busy || confirmation !== projectName} type="submit" variant="danger">
            {busy ? 'Requesting deletion…' : `Delete ${projectName}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
