import { clsx } from 'clsx';
import { Coins } from 'lucide-react';
import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, type = 'button', variant = 'primary', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx('zapp-button', `zapp-button--${variant}`, className)}
      {...props}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={clsx('zapp-icon-button', className)}
      {...props}
    />
  );
});

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly selected?: boolean;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { className, selected = false, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={clsx('zapp-chip', selected && 'zapp-chip--selected', className)}
      {...props}
    />
  );
});

type CardElement = 'article' | 'div' | 'main' | 'section';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  readonly as?: CardElement;
}

export function Card({ as: Component = 'div', className, ...props }: CardProps): ReactNode {
  return <Component className={clsx('zapp-card', className)} {...props} />;
}

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  readonly name: string;
  readonly src?: string;
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.at(0)?.toUpperCase() ?? '')
    .join('');
}

export function Avatar({ className, name, src, ...props }: AvatarProps): ReactNode {
  return (
    <span className={clsx('zapp-avatar', className)} aria-label={name} role="img" {...props}>
      {src === undefined ? (
        <span aria-hidden="true">{initials(name)}</span>
      ) : (
        <img className="zapp-avatar__image" src={src} alt="" />
      )}
    </span>
  );
}

export interface CreditsPillProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'children'
> {
  readonly credits: number;
  readonly href?: string;
}

export function CreditsPill({
  className,
  credits,
  href = '/org/usage',
  ...props
}: CreditsPillProps): ReactNode {
  return (
    <a className={clsx('zapp-credits-pill', className)} href={href} {...props}>
      <Coins aria-hidden="true" size={14} />
      <span>{credits.toLocaleString()} credits</span>
    </a>
  );
}

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>): ReactNode {
  return <kbd className={clsx('zapp-kbd', className)} {...props} />;
}

export interface CodeBlockProps extends HTMLAttributes<HTMLPreElement> {
  readonly children: string;
  readonly language?: string;
}

export function CodeBlock({
  children,
  className,
  language = 'text',
  ...props
}: CodeBlockProps): ReactNode {
  return (
    <pre className={clsx('zapp-code-block', className)} aria-label={`${language} code`} {...props}>
      <code>{children}</code>
    </pre>
  );
}
