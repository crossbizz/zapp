import { clsx } from 'clsx';
import type { HTMLAttributes, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

export interface MarkdownProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  readonly children: string;
}

export function Markdown({ children, className, ...props }: MarkdownProps): ReactNode {
  return (
    <div className={clsx('zapp-markdown', className)} {...props}>
      <ReactMarkdown skipHtml>{children}</ReactMarkdown>
    </div>
  );
}
