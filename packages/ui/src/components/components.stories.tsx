import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';
import {
  Avatar,
  Button,
  Card,
  Chip,
  CodeBlock,
  CreditsPill,
  Dialog,
  Drawer,
  EmptyState,
  EnvBadge,
  ErrorState,
  IconButton,
  Kbd,
  Markdown,
  ProgressBar,
  Spinner,
  StatusPill,
  SupportLevelBadge,
  Tabs,
  Timeline,
  TimelineStage,
  Toast,
  Tooltip,
} from '../index';

const meta = {
  title: 'Components/Public API',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ButtonStory: Story = { render: () => <Button>Build app</Button> };
export const IconButtonStory: Story = {
  render: () => <IconButton label="Refresh preview">↻</IconButton>,
};
export const ChipStory: Story = { render: () => <Chip>Web app</Chip> };
export const TabsStory: Story = {
  render: () => (
    <Tabs
      label="Builder surface"
      defaultValue="preview"
      items={[
        { value: 'preview', label: 'Preview', content: 'Preview content' },
        { value: 'code', label: 'Code', content: 'Code content' },
      ]}
    />
  ),
};
export const CardStory: Story = { render: () => <Card>Project summary</Card> };
export const StatusPillStory: Story = {
  render: () => <StatusPill status="success">Passed</StatusPill>,
};
export const EnvBadgeStory: Story = {
  render: () => (
    <div className="zapp-story-row">
      <EnvBadge environment="preview" />
      <EnvBadge environment="production" />
    </div>
  ),
};
export const SupportLevelBadgeStory: Story = {
  render: () => (
    <div className="zapp-story-row">
      <SupportLevelBadge level="compatible" />
      <SupportLevelBadge level="verified" />
      <SupportLevelBadge level="managed" />
    </div>
  ),
};
export const DrawerStory: Story = {
  render: () => (
    <Drawer
      defaultOpen
      description="Live run details and controls."
      trigger={<Button>Open Mission Control</Button>}
      title="Mission Control"
    >
      Current run details
    </Drawer>
  ),
};
export const DialogStory: Story = {
  render: () => (
    <Dialog
      defaultOpen
      description="Review the production impact before continuing."
      trigger={<Button>Open confirmation</Button>}
      title="Confirm deployment"
    >
      Review deployment details.
    </Dialog>
  ),
};
export const TooltipStory: Story = {
  render: () => (
    <Tooltip content="Refresh preview" defaultOpen>
      <IconButton label="Refresh preview">↻</IconButton>
    </Tooltip>
  ),
};
export const AvatarStory: Story = { render: () => <Avatar name="Ada Lovelace" /> };
export const CreditsPillStory: Story = { render: () => <CreditsPill credits={240} /> };
export const ProgressBarStory: Story = {
  render: () => <ProgressBar value={72} label="Build progress" />,
};
export const SpinnerStory: Story = { render: () => <Spinner label="Starting preview" /> };
export const TimelineStory: Story = {
  render: () => (
    <Timeline label="Deployment stages">
      <TimelineStage status="complete" title="Build" />
      <TimelineStage status="active" title="Deploy" />
    </Timeline>
  ),
};
export const TimelineStageStory: Story = {
  render: () => (
    <Timeline label="Current stage">
      <TimelineStage status="active" title="Running verification" />
    </Timeline>
  ),
};
export const EmptyStateStory: Story = {
  render: () => <EmptyState title="No projects" description="Start with a prompt." />,
};
export const ErrorStateStory: Story = {
  render: () => (
    <ErrorState
      title="Build failed"
      onFixAutomatically={fn()}
      onInspectDetails={fn()}
      onRetry={fn()}
      onAskAgent={fn()}
    />
  ),
};
export const KbdStory: Story = { render: () => <Kbd>⌘ K</Kbd> };
export const CodeBlockStory: Story = {
  render: () => <CodeBlock language="tsx">{'const ready = true;'}</CodeBlock>,
};
export const MarkdownStory: Story = {
  render: () => <Markdown>{'## Build summary\n\nVerification **passed**.'}</Markdown>,
};
export const ToastStory: Story = {
  render: () => (
    <Toast
      action={<Button>Undo</Button>}
      actionAltText="Undo the saved change"
      open
      title="Saved"
      description="Project settings saved."
    />
  ),
};
