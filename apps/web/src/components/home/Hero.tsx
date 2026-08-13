'use client';

import { Tabs, Tooltip } from '@zapp/ui';
import { useState, type KeyboardEvent, type ReactElement } from 'react';

import { type CreateRunInput } from '../../lib/api';
import type { HomeFeatureFlags } from '../../lib/feature-flags';
import { PromptComposer } from './PromptComposer';
import { SuggestionChips } from './SuggestionChips';
import styles from './home.module.css';

interface HomeCopy {
  readonly heading: string;
}

const HOME_COPY = {
  heading: "Start with one prompt. We'll take it to production.",
} as const satisfies HomeCopy;

type AppType = NonNullable<CreateRunInput['appType']>;

export interface HeroProps {
  readonly allowedModels: readonly string[];
  readonly flags: HomeFeatureFlags;
  readonly organizationId: string;
}

export function Hero({
  allowedModels,
  flags,
  organizationId,
}: HeroProps): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [appType, setAppType] = useState<AppType>('web');
  const [supportOpen, setSupportOpen] = useState(false);
  const composer = (
    <PromptComposer
      allowedModels={allowedModels}
      appType={appType}
      organizationId={organizationId}
      onPromptChange={setPrompt}
      prompt={prompt}
      voiceInputEnabled={flags.voiceInput}
    />
  );
  const mobileLabel = (
    <span>
      Mobile App
      {flags.mobileApp ? null : <span className="zapp-sr-only"> Coming after P0</span>}
    </span>
  );
  return (
    <div className={styles.home}>
      <div className={styles.heroContent}>
        <h1 className={styles.heading}>{HOME_COPY.heading}</h1>
        <div
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            const target = event.target;
            if (
              event.key === 'Tab'
              && !event.shiftKey
              && target instanceof HTMLElement
              && target.getAttribute('role') === 'tab'
              && target.getAttribute('aria-selected') === 'true'
            ) {
              event.preventDefault();
              document.querySelector<HTMLTextAreaElement>('#home-prompt')?.focus();
            }
          }}
        >
          {flags.mobileApp ? null : (
            <div className={styles.productHelp}>
              <Tooltip content="Mobile App is coming after P0.">
                <button
                  aria-label="Why Mobile App is unavailable"
                  className={styles.productHelpButton}
                  type="button"
                >
                  ?
                </button>
              </Tooltip>
            </div>
          )}
          <Tabs
            defaultValue="web"
            items={[
              { content: null, label: 'Web App', value: 'web' },
              {
                content: null,
                disabled: !flags.mobileApp,
                label: mobileLabel,
                value: 'mobile',
              },
            ]}
            label="Product type"
            onValueChange={(value) => {
              if (value === 'web' || (value === 'mobile' && flags.mobileApp)) {
                setAppType(value);
              }
            }}
            value={appType}
          />
          {composer}
        </div>
        <SuggestionChips onSelect={setPrompt} />
      </div>

      <aside className={styles.support} aria-label="Support">
        <button
          aria-expanded={supportOpen}
          aria-label="Support"
          className={styles.supportButton}
          onClick={() => {
            setSupportOpen((open) => !open);
          }}
          type="button"
        >
          ?
        </button>
        {supportOpen ? (
          <div className={styles.supportMenu}>
            <a href="https://docs.zapp.build">Read the docs</a>
            <a href="mailto:support@zapp.build">Contact support</a>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
