'use client';

import { Button, Dialog } from '@zapp/ui';
import { useState, type ReactElement } from 'react';

import { PromptComposer } from '../home/PromptComposer';
import styles from './projects.module.css';

export interface NewProjectDialogProps {
  readonly allowedModels: readonly string[];
  readonly organizationId: string;
}

export function NewProjectDialog({
  allowedModels,
  organizationId,
}: NewProjectDialogProps): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [open, setOpen] = useState(false);

  return (
    <Dialog
      className={styles.newProjectDialog ?? ''}
      description="Describe the project and zapp will start the first build."
      onOpenChange={setOpen}
      open={open}
      title="Create a new project"
      trigger={<Button>New project</Button>}
    >
      <PromptComposer
        allowedModels={allowedModels}
        appType="web"
        githubImportEnabled
        organizationId={organizationId}
        onPromptChange={setPrompt}
        onGitHubImport={() => {
          setOpen(false);
        }}
        prompt={prompt}
        voiceInputEnabled={false}
      />
    </Dialog>
  );
}
