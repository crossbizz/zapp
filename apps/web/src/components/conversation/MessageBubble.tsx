import { Markdown } from '@zapp/ui';
import type { ReactElement } from 'react';

export interface MessageBubbleProps {
  readonly attachmentNames?: readonly string[];
  readonly content: string;
  readonly deliveryStatus?: 'Applied' | 'Queued' | undefined;
  readonly role: 'assistant' | 'user';
}

export function MessageBubble({
  attachmentNames = [],
  content,
  deliveryStatus,
  role,
}: MessageBubbleProps): ReactElement {
  return (
    <article
      aria-label={role === 'user' ? 'You' : 'Agent'}
      className="zapp-conversation-message"
      data-role={role}
    >
      {role === 'assistant' ? <Markdown>{content}</Markdown> : <p>{content}</p>}
      {deliveryStatus === undefined ? null : (
        <small className="zapp-conversation-message-delivery" role="status">
          {deliveryStatus}
        </small>
      )}
      {attachmentNames.length === 0 ? null : (
        <ul aria-label="Message attachments" className="zapp-conversation-message-attachments">
          {attachmentNames.map((name, index) => (
            <li key={`${name}-${String(index)}`}>{name}</li>
          ))}
        </ul>
      )}
    </article>
  );
}
