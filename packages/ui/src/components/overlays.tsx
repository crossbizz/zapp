'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as ToastPrimitive from '@radix-ui/react-toast';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

export interface TabItem {
  readonly content: ReactNode;
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly value: string;
}

export interface TabsProps {
  readonly className?: string;
  readonly defaultValue: string;
  readonly items: readonly TabItem[];
  readonly label: string;
  readonly onValueChange?: (value: string) => void;
  readonly value?: string;
}

export function Tabs({
  className,
  defaultValue,
  items,
  label,
  onValueChange,
  value,
}: TabsProps): ReactNode {
  const rootProps = {
    ...(value === undefined ? { defaultValue } : { value }),
    ...(onValueChange === undefined ? {} : { onValueChange }),
  };
  return (
    <TabsPrimitive.Root className={clsx('zapp-tabs', className)} {...rootProps}>
      <TabsPrimitive.List className="zapp-tabs__list" aria-label={label}>
        {items.map((item) => (
          <TabsPrimitive.Trigger
            className="zapp-tabs__trigger"
            disabled={item.disabled}
            key={item.value}
            value={item.value}
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content className="zapp-tabs__content" key={item.value} value={item.value}>
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

interface OverlayProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly defaultOpen?: boolean;
  readonly description?: ReactNode;
  readonly onOpenChange?: (open: boolean) => void;
  readonly open?: boolean;
  readonly title: ReactNode;
  readonly trigger: ReactElement;
}

function rootProps({
  defaultOpen,
  onOpenChange,
  open,
}: Pick<OverlayProps, 'defaultOpen' | 'onOpenChange' | 'open'>): DialogPrimitive.DialogProps {
  return {
    ...(open === undefined ? (defaultOpen === undefined ? {} : { defaultOpen }) : { open }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
  };
}

export type DialogProps = OverlayProps;

export function Dialog(props: DialogProps): ReactNode {
  return (
    <DialogPrimitive.Root {...rootProps(props)}>
      <DialogPrimitive.Trigger asChild>{props.trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="zapp-overlay" />
        <DialogPrimitive.Content
          className={clsx('zapp-dialog', props.className)}
          {...(props.description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <DialogPrimitive.Title className="zapp-overlay-panel__title">
            {props.title}
          </DialogPrimitive.Title>
          {props.description === undefined ? null : (
            <DialogPrimitive.Description className="zapp-overlay-panel__description">
              {props.description}
            </DialogPrimitive.Description>
          )}
          <div className="zapp-overlay-panel__body">{props.children}</div>
          <DialogPrimitive.Close className="zapp-overlay-panel__close" aria-label="Close dialog">
            <X aria-hidden="true" size={18} />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export type DrawerProps = OverlayProps;

export function Drawer(props: DrawerProps): ReactNode {
  return (
    <DialogPrimitive.Root {...rootProps(props)}>
      <DialogPrimitive.Trigger asChild>{props.trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="zapp-overlay" />
        <DialogPrimitive.Content
          className={clsx('zapp-drawer', props.className)}
          {...(props.description === undefined ? { 'aria-describedby': undefined } : {})}
        >
          <DialogPrimitive.Title className="zapp-overlay-panel__title">
            {props.title}
          </DialogPrimitive.Title>
          {props.description === undefined ? null : (
            <DialogPrimitive.Description className="zapp-overlay-panel__description">
              {props.description}
            </DialogPrimitive.Description>
          )}
          <div className="zapp-overlay-panel__body">{props.children}</div>
          <DialogPrimitive.Close className="zapp-overlay-panel__close" aria-label="Close drawer">
            <X aria-hidden="true" size={18} />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface TooltipProps {
  readonly children: ReactElement;
  readonly content: ReactNode;
  readonly defaultOpen?: boolean;
}

export function Tooltip({ children, content, defaultOpen }: TooltipProps): ReactNode {
  return (
    <TooltipPrimitive.Provider delayDuration={0}>
      <TooltipPrimitive.Root {...(defaultOpen === undefined ? {} : { defaultOpen })}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="zapp-tooltip" sideOffset={6}>
            {content}
            <TooltipPrimitive.Arrow className="zapp-tooltip__arrow" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export interface ToastBaseProps {
  readonly description?: ReactNode;
  readonly duration?: number;
  readonly onOpenChange?: (open: boolean) => void;
  readonly open?: boolean;
  readonly title: ReactNode;
}

interface ToastWithAction {
  readonly action: ReactElement;
  readonly actionAltText: string;
}

interface ToastWithoutAction {
  readonly action?: never;
  readonly actionAltText?: never;
}

export type ToastProps = ToastBaseProps & (ToastWithAction | ToastWithoutAction);

export function Toast(props: ToastProps): ReactNode {
  const { description, duration = 5000, onOpenChange, open, title } = props;
  const toastProps = {
    ...(open === undefined ? {} : { open }),
    ...(onOpenChange === undefined ? {} : { onOpenChange }),
  };
  return (
    <ToastPrimitive.Provider duration={duration} swipeDirection="right">
      <ToastPrimitive.Root className="zapp-toast" {...toastProps}>
        <ToastPrimitive.Title className="zapp-toast__title">{title}</ToastPrimitive.Title>
        {description === undefined ? null : (
          <ToastPrimitive.Description className="zapp-toast__description">
            {description}
          </ToastPrimitive.Description>
        )}
        {props.action === undefined ? null : (
          <ToastPrimitive.Action altText={props.actionAltText} asChild>
            {props.action}
          </ToastPrimitive.Action>
        )}
        <ToastPrimitive.Close className="zapp-toast__close" aria-label="Dismiss notification">
          <X aria-hidden="true" size={16} />
        </ToastPrimitive.Close>
      </ToastPrimitive.Root>
      <ToastPrimitive.Viewport className="zapp-toast-viewport" aria-label="Notifications" />
    </ToastPrimitive.Provider>
  );
}
