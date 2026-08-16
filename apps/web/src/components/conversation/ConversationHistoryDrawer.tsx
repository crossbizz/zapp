'use client';

import { Button, Drawer, EmptyState } from '@zapp/ui';
import { useState, type ReactElement } from 'react';

import type { ProjectConversation } from '../../lib/api';
import styles from '../builder/builder.module.css';

interface ConversationHistoryDrawerProps {
  readonly conversations: readonly ProjectConversation[];
  readonly error: string | undefined;
  readonly loading: boolean;
  readonly onNewThread: () => void;
  readonly onRetry: () => void;
  readonly onSelect: (conversationId: string) => void;
  readonly selectedConversationId: string | undefined;
}

function conversationDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function ConversationHistoryDrawer({
  conversations,
  error,
  loading,
  onNewThread,
  onRetry,
  onSelect,
  selectedConversationId,
}: ConversationHistoryDrawerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const historyTrigger = (
    <Button aria-label="History" variant="secondary">
      History
    </Button>
  );

  return (
    <div className={styles.conversationActions}>
      <Drawer
        {...(styles.conversationHistoryDrawer === undefined
          ? {}
          : { className: styles.conversationHistoryDrawer })}
        description="All chat threads saved in this project."
        onOpenChange={setOpen}
        open={open}
        title="History"
        trigger={historyTrigger}
      >
        <div className={styles.conversationHistoryHeader}>
          <Button
            onClick={() => {
              setOpen(false);
              onNewThread();
            }}
            variant="primary"
          >
            New thread
          </Button>
        </div>
        {loading ? <p role="status">Loading history…</p> : null}
        {error === undefined ? null : (
          <div role="alert">
            <p>{error}</p>
            <Button aria-label="Retry conversation history" onClick={onRetry} variant="secondary">
              Retry
            </Button>
          </div>
        )}
        {!loading && error === undefined && conversations.length === 0 ? (
          <EmptyState description="Start a new thread to begin." title="No chat history" />
        ) : null}
        <ol aria-label="Project chat history" className={styles.conversationHistoryList}>
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                aria-current={conversation.id === selectedConversationId ? 'page' : undefined}
                onClick={() => {
                  setOpen(false);
                  onSelect(conversation.id);
                }}
                type="button"
              >
                <strong>{conversation.title}</strong>
                <span>
                  {conversation.runCount === 1
                    ? '1 run'
                    : `${String(conversation.runCount)} runs`}{' '}
                  · {conversationDate(conversation.updatedAt)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </Drawer>
      <Button aria-label="New thread" onClick={onNewThread} variant="secondary">
        New thread
      </Button>
    </div>
  );
}
