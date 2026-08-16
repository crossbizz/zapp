'use client';

import { Markdown } from '@zapp/ui';
import * as React from 'react';

import { formatConversationTimestamp } from './message-time';

export interface MessageBubbleProps {
  readonly attachmentNames?: readonly string[];
  readonly content: string;
  readonly deliveryStatus?: 'Applied' | 'Queued' | undefined;
  readonly role: 'assistant' | 'user';
  readonly timestamp?: string;
}

function subscribeToTimestamp(): () => void {
  return () => undefined;
}

export function MessageBubble({
  attachmentNames = [],
  content,
  deliveryStatus,
  role,
  timestamp,
}: MessageBubbleProps): React.ReactElement {
  const timestampLabel = React.useSyncExternalStore(
    subscribeToTimestamp,
    () => (timestamp === undefined ? undefined : formatConversationTimestamp(timestamp)),
    () => undefined,
  );

  return (
    <article
      aria-label={role === 'user' ? 'You' : 'Agent'}
      className="zapp-conversation-message"
      data-role={role}
    >
      {role === 'assistant' ? <Markdown>{content}</Markdown> : <p>{content}</p>}
      {attachmentNames.length === 0 ? null : (
        <ul aria-label="Message attachments" className="zapp-conversation-message-attachments">
          {attachmentNames.map((name, index) => (
            <li key={`${name}-${String(index)}`}>{name}</li>
          ))}
        </ul>
      )}
      {deliveryStatus === undefined && timestampLabel === undefined ? null : (
        <footer className="zapp-conversation-message-meta">
          {deliveryStatus === undefined ? null : <span role="status">{deliveryStatus}</span>}
          {timestampLabel === undefined || timestamp === undefined ? null : (
            <time dateTime={timestamp}>{timestampLabel}</time>
          )}
        </footer>
      )}
    </article>
  );
}
