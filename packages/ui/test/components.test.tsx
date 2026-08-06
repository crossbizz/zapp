import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as UI from '../src/index';

const publicComponents = [
  'Button',
  'IconButton',
  'Chip',
  'Tabs',
  'Card',
  'StatusPill',
  'EnvBadge',
  'SupportLevelBadge',
  'Drawer',
  'Dialog',
  'Tooltip',
  'Avatar',
  'CreditsPill',
  'ProgressBar',
  'Spinner',
  'Timeline',
  'TimelineStage',
  'EmptyState',
  'ErrorState',
  'Kbd',
  'CodeBlock',
  'Markdown',
  'Toast',
] as const;

describe('@zapp/ui public contract', () => {
  it('exports every component named by WEB-2', () => {
    for (const name of publicComponents) {
      expect(UI[name], `${name} must be exported`).toBeDefined();
    }
  });

  it('renders exact environment and support labels with non-color icon semantics', () => {
    const { container } = render(
      <div>
        <UI.EnvBadge environment="preview" />
        <UI.EnvBadge environment="production" />
        <UI.SupportLevelBadge level="compatible" />
        <UI.SupportLevelBadge level="verified" />
        <UI.SupportLevelBadge level="managed" />
      </div>,
    );

    expect(screen.getByText('Preview')).toBeVisible();
    expect(screen.getByText('Production')).toBeVisible();
    expect(screen.getByText('Compatible')).toBeVisible();
    expect(screen.getByText('Verified')).toBeVisible();
    expect(screen.getByText('Managed')).toBeVisible();
    expect(container.querySelectorAll('[data-icon="shield-check"]')).toHaveLength(2);
    expect(container.querySelector('[data-icon="settings"]')).toBeInTheDocument();
  });

  it('pairs every status with an icon and visible label', () => {
    const { container } = render(
      <div>
        <UI.StatusPill status="success">Passed</UI.StatusPill>
        <UI.StatusPill status="warning">Needs review</UI.StatusPill>
        <UI.StatusPill status="danger">Failed</UI.StatusPill>
        <UI.StatusPill status="info">Running</UI.StatusPill>
      </div>,
    );

    for (const label of ['Passed', 'Needs review', 'Failed', 'Running']) {
      expect(screen.getByText(label)).toBeVisible();
    }
    expect(container.querySelectorAll('[data-status-icon]')).toHaveLength(4);
  });

  it('gives text-only avatars an image role and accessible name', () => {
    render(<UI.Avatar name="Ada Lovelace" />);

    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL');
  });

  it('exposes progress value, bounds, and accessible name', () => {
    render(<UI.ProgressBar value={72} label="Build progress" />);

    const progress = screen.getByRole('progressbar', { name: 'Build progress' });
    expect(progress).toHaveAttribute('aria-valuemin', '0');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(progress).toHaveAttribute('aria-valuenow', '72');
  });

  it('offers all four required recovery actions and invokes the selected action', async () => {
    const user = userEvent.setup();
    const actions = {
      onFixAutomatically: vi.fn(),
      onInspectDetails: vi.fn(),
      onRetry: vi.fn(),
      onAskAgent: vi.fn(),
    };
    render(<UI.ErrorState title="Build failed" {...actions} />);

    const expected = [
      ['Fix automatically', actions.onFixAutomatically],
      ['Inspect details', actions.onInspectDetails],
      ['Retry', actions.onRetry],
      ['Ask the agent', actions.onAskAgent],
    ] as const;
    for (const [label, handler] of expected) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  it('does not turn raw Markdown HTML into DOM elements', () => {
    const { container } = render(
      <UI.Markdown>{'Hello <img src=x onerror="alert(1)">\n\n**safe**'}</UI.Markdown>,
    );

    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('safe').tagName).toBe('STRONG');
    expect(screen.queryByText(/<img src=x/)).not.toBeInTheDocument();
  });

  it('opens and dismisses dialogs with keyboard focus behavior', async () => {
    const user = userEvent.setup();
    render(
      <UI.Dialog trigger={<UI.Button>Open dialog</UI.Button>} title="Confirm release">
        Release details
      </UI.Dialog>,
    );

    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(screen.getByRole('dialog', { name: 'Confirm release' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open dialog' })).toHaveFocus();
  });

  it('opens and dismisses drawers with an accessible title', async () => {
    const user = userEvent.setup();
    render(
      <UI.Drawer trigger={<UI.Button>Open drawer</UI.Button>} title="Mission Control">
        Run status
      </UI.Drawer>,
    );

    await user.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(screen.getByRole('dialog', { name: 'Mission Control' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('supports tab selection and keyboard navigation', async () => {
    const user = userEvent.setup();
    render(
      <UI.Tabs
        label="Builder surface"
        defaultValue="preview"
        items={[
          { value: 'preview', label: 'Preview', content: 'Preview content' },
          { value: 'code', label: 'Code', content: 'Code content' },
        ]}
      />,
    );

    const tablist = screen.getByRole('tablist', { name: 'Builder surface' });
    const preview = within(tablist).getByRole('tab', { name: 'Preview' });
    preview.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(tablist).getByRole('tab', { name: 'Code' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Code content')).toBeVisible();
  });

  it('reveals tooltip content to keyboard users', async () => {
    const user = userEvent.setup();
    render(
      <UI.Tooltip content="Refresh preview">
        <UI.IconButton label="Refresh">↻</UI.IconButton>
      </UI.Tooltip>,
    );

    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Refresh preview');
  });

  it('announces spinners, timelines, empty states, and toast messages', () => {
    render(
      <div>
        <UI.Spinner label="Starting preview" />
        <UI.Timeline label="Deployment stages">
          <UI.TimelineStage status="complete" title="Build" />
          <UI.TimelineStage status="active" title="Deploy" />
        </UI.Timeline>
        <UI.EmptyState title="No projects" description="Start with a prompt." />
        <UI.Toast open title="Saved" description="Project settings saved." />
      </div>,
    );

    expect(screen.getByRole('status', { name: 'Starting preview' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Deployment stages' })).toBeVisible();
    expect(screen.getByText('No projects')).toBeVisible();
    expect(screen.getByText('Project settings saved.')).toBeVisible();
  });

  it('announces textual status for every timeline stage state', () => {
    const stages = [
      ['pending', 'Queued', 'Pending'],
      ['active', 'Building', 'Active'],
      ['complete', 'Verified', 'Complete'],
      ['failed', 'Deploy', 'Failed'],
    ] as const;
    render(
      <UI.Timeline label="Run stages">
        {stages.map(([status, title]) => (
          <UI.TimelineStage key={status} status={status} title={title} />
        ))}
      </UI.Timeline>,
    );

    for (const [, title, statusLabel] of stages) {
      const stage = screen.getByText(title).closest('li');
      expect(stage).not.toBeNull();
      expect(within(stage as HTMLLIElement).getByText(`Status: ${statusLabel}`)).toHaveClass(
        'zapp-sr-only',
      );
    }
  });

  it('passes action-specific Toast alt text to the screen-reader announcement contract', () => {
    const { container } = render(
      <UI.Toast
        action={<UI.Button>Undo</UI.Button>}
        actionAltText="Undo the saved change"
        open
        title="Saved"
      />,
    );

    expect(
      container.querySelector('[data-radix-toast-announce-alt="Undo the saved change"]'),
    ).toBeInTheDocument();
  });
});
