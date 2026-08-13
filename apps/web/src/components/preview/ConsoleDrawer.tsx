'use client';

import type { BuilderPreviewEvent } from '@zapp/api-client';
import { Button, Drawer, EmptyState } from '@zapp/ui';
import { type ReactElement } from 'react';

interface ConsoleDrawerProps {
  readonly attaching: boolean;
  readonly events: readonly BuilderPreviewEvent[];
  readonly onAttach: (event: BuilderPreviewEvent) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

function eventDescription(event: BuilderPreviewEvent): string {
  switch (event.type) {
    case 'console':
      return event.payload.message;
    case 'runtime_error':
      return event.payload.message;
    case 'network':
      return `${event.payload.method} ${String(event.payload.status)} ${event.payload.url}`;
    case 'route_change':
      return event.payload.url;
  }
}

function eventKind(event: BuilderPreviewEvent): string {
  switch (event.type) {
    case 'console':
      return `Console ${event.payload.level}`;
    case 'runtime_error':
      return 'Runtime error';
    case 'network':
      return 'Network';
    case 'route_change':
      return 'Route';
  }
}

function isError(event: BuilderPreviewEvent): boolean {
  return (
    event.type === 'runtime_error' ||
    (event.type === 'console' && event.payload.level === 'error') ||
    (event.type === 'network' && event.payload.status >= 400)
  );
}

export function ConsoleDrawer({
  attaching,
  events,
  onAttach,
  onOpenChange,
  open,
}: ConsoleDrawerProps): ReactElement {
  return (
    <Drawer
      description="Captured browser console, runtime, route, and network events."
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById('conversation-message')?.focus();
      }}
      onOpenChange={onOpenChange}
      open={open}
      title="Preview console"
      trigger={<Button variant="secondary">Console</Button>}
    >
      {events.length === 0 ? (
        <EmptyState
          description="Console and network captures will appear while the preview is open."
          title="No captured activity"
        />
      ) : (
        <table className="zapp-preview-capture-table">
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Detail</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event, index) => (
              <tr key={`${event.type}-${String(index)}`}>
                <th scope="row">{eventKind(event)}</th>
                <td>{eventDescription(event)}</td>
                <td>
                  {isError(event) ? (
                    <Button
                      disabled={attaching}
                      onClick={() => {
                        onAttach(event);
                      }}
                      variant="secondary"
                    >
                      Attach to chat
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
