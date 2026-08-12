'use client';

import { Chip } from '@zapp/ui';
import Link from 'next/link';
import { useState, type ReactElement } from 'react';

import styles from './home.module.css';

interface Suggestion {
  readonly color: 'accent' | 'info' | 'success';
  readonly label: string;
}

const SUGGESTIONS = [
  { color: 'accent', label: 'Client portal for an agency' },
  { color: 'info', label: 'Class scheduler for a yoga studio' },
  { color: 'success', label: 'SaaS dashboard with Stripe billing' },
  { color: 'success', label: 'Inventory tracker for a small retailer' },
  { color: 'accent', label: 'Community event planning hub' },
  { color: 'info', label: 'Restaurant reservation manager' },
  { color: 'info', label: 'Field service dispatch board' },
  { color: 'success', label: 'Membership site for a local club' },
  { color: 'accent', label: 'Customer feedback research portal' },
] as const satisfies readonly Suggestion[];

const GROUP_SIZE = 3;

const SUGGESTION_DOT_CLASSES: Readonly<Record<Suggestion['color'], string | undefined>> = {
  accent: styles.suggestionDotAccent,
  info: styles.suggestionDotInfo,
  success: styles.suggestionDotSuccess,
};

export interface SuggestionChipsProps {
  readonly onSelect: (suggestion: string) => void;
}

export function SuggestionChips({ onSelect }: SuggestionChipsProps): ReactElement {
  const [group, setGroup] = useState(0);
  const suggestions = SUGGESTIONS.slice(group * GROUP_SIZE, (group + 1) * GROUP_SIZE);

  return (
    <section className={styles.suggestions} aria-labelledby="home-suggestions-title">
      <p className={styles.suggestionsTitle} id="home-suggestions-title">
        Not sure where to start? Try these
      </p>
      <div className={styles.suggestionList}>
        {suggestions.map((suggestion) => (
          <Chip key={suggestion.label} onClick={() => {
            onSelect(suggestion.label);
          }}>
            <span
              aria-hidden="true"
              className={`${styles.suggestionDot ?? ''} ${SUGGESTION_DOT_CLASSES[suggestion.color] ?? ''}`}
            />
            {suggestion.label}
          </Chip>
        ))}
      </div>
      <button
        aria-label="Shuffle suggestions"
        className={styles.shuffleButton}
        onClick={() => {
          setGroup((current) => (current + 1) % (SUGGESTIONS.length / GROUP_SIZE));
        }}
        type="button"
      >
        ⇄
      </button>
      <Link href="/templates">Browse templates</Link>
    </section>
  );
}
