import type { ProjectSettingsSection } from '../settings/settings-types';

export type BuilderMode = 'preview' | 'manage';
export type BuilderPane = 'conversation' | 'workspace';
export type PreviewSection =
  | 'preview'
  | 'files'
  | 'code'
  | 'more'
  | 'logs'
  | 'tests'
  | 'releases'
  | 'health';
export type MoreSubview =
  | 'analytics'
  | 'cloud'
  | 'ai'
  | 'mcp'
  | 'payments'
  | 'connectors'
  | 'security'
  | 'seo';
export type ManageSection = ProjectSettingsSection;

export interface BuilderNavigation {
  readonly manage: ManageSection;
  readonly more: MoreSubview;
  readonly mode: BuilderMode;
  readonly pane: BuilderPane;
  readonly preview: PreviewSection;
}

interface NavigationSearch {
  get(name: string): string | null;
}

const previewSections = new Set<PreviewSection>([
  'preview',
  'files',
  'code',
  'more',
  'logs',
  'tests',
  'releases',
  'health',
]);
const moreSubviews = new Set<MoreSubview>([
  'analytics',
  'cloud',
  'ai',
  'mcp',
  'payments',
  'connectors',
  'security',
  'seo',
]);
const manageSections = new Set<ManageSection>([
  'general',
  'secrets',
  'integrations',
  'payments',
  'members',
  'github',
]);

export const DEFAULT_BUILDER_NAVIGATION: BuilderNavigation = {
  manage: 'general',
  more: 'analytics',
  mode: 'preview',
  pane: 'conversation',
  preview: 'preview',
};

function moreSubview(value: string | null): MoreSubview {
  return moreSubviews.has(value as MoreSubview)
    ? value as MoreSubview
    : DEFAULT_BUILDER_NAVIGATION.more;
}

function previewSection(value: string | null): PreviewSection {
  return previewSections.has(value as PreviewSection)
    ? value as PreviewSection
    : DEFAULT_BUILDER_NAVIGATION.preview;
}

function manageSection(value: string | null): ManageSection {
  return manageSections.has(value as ManageSection)
    ? value as ManageSection
    : DEFAULT_BUILDER_NAVIGATION.manage;
}

export function parseBuilderNavigation(search: NavigationSearch): BuilderNavigation {
  return {
    manage: manageSection(search.get('section')),
    more: moreSubview(search.get('subview')),
    mode: search.get('mode') === 'manage' ? 'manage' : 'preview',
    pane: search.get('pane') === 'workspace' ? 'workspace' : 'conversation',
    preview: previewSection(search.get('view')),
  };
}

export function serializeBuilderNavigation(navigation: BuilderNavigation): string {
  const search = new URLSearchParams();
  if (navigation.mode !== DEFAULT_BUILDER_NAVIGATION.mode) search.set('mode', navigation.mode);
  if (navigation.preview !== DEFAULT_BUILDER_NAVIGATION.preview) {
    search.set('view', navigation.preview);
  }
  if (navigation.preview === 'more' && navigation.more !== DEFAULT_BUILDER_NAVIGATION.more) {
    search.set('subview', navigation.more);
  }
  if (navigation.manage !== DEFAULT_BUILDER_NAVIGATION.manage) {
    search.set('section', navigation.manage);
  }
  if (navigation.pane !== DEFAULT_BUILDER_NAVIGATION.pane) search.set('pane', navigation.pane);
  return search.toString();
}
