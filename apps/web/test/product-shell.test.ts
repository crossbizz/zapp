import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  appSessionStorageKey,
  resolveAppMembership,
  type AppMembership,
} from '../src/lib/app-session.js';
import {
  recentProjectDestination,
  shellDestinations,
} from '../src/components/shell/shell-navigation.js';

const memberships = [
  {
    allowedModels: ['anthropic/claude-sonnet-5'],
    organization: { id: 'org_alpha', name: 'Alpha', slug: 'alpha' },
    role: 'owner',
    status: 'active',
  },
  {
    allowedModels: [],
    organization: { id: 'org_beta', name: 'Beta', slug: 'beta' },
    role: 'viewer',
    status: 'active',
  },
  {
    allowedModels: [],
    organization: { id: 'org_invited', name: 'Invited', slug: 'invited' },
    role: 'viewer',
    status: 'invited',
  },
] satisfies readonly AppMembership[];

void describe('product shell session selection', () => {
  void it('uses an active URL override before a persisted organization', () => {
    const selected = resolveAppMembership(memberships, 'org_beta', 'org_alpha');

    assert.equal(selected.membership?.organization.id, 'org_beta');
    assert.equal(selected.invalidOverride, false);
  });

  void it('rejects invited overrides and falls back to persisted active membership', () => {
    const selected = resolveAppMembership(memberships, 'org_invited', 'org_beta');

    assert.equal(selected.membership?.organization.id, 'org_beta');
    assert.equal(selected.invalidOverride, true);
  });

  void it('names persisted selection by authenticated user', () => {
    assert.equal(appSessionStorageKey('user_123'), 'zapp:selected-organization:user_123');
  });
});

void describe('product shell navigation', () => {
  void it('shows account billing only to owners', () => {
    assert.deepEqual(shellDestinations('owner').map(({ label }) => label), [
      'Dashboard',
      'Projects',
      'Templates',
      'Usage',
      'Billing',
    ]);
    assert.deepEqual(shellDestinations('builder').map(({ label }) => label), [
      'Dashboard',
      'Projects',
      'Templates',
      'Usage',
    ]);
  });

  void it('keeps viewer destinations read-only and public-API-backed', () => {
    assert.deepEqual(shellDestinations('viewer'), [
      { href: '/', icon: 'dashboard', label: 'Dashboard' },
      { href: '/projects', icon: 'projects', label: 'Projects' },
      { href: '/templates', icon: 'templates', label: 'Templates' },
      { href: '/org/usage', icon: 'usage', label: 'Usage' },
    ]);
  });

  void it('builds recent project destinations without leaking organization state', () => {
    assert.deepEqual(
      recentProjectDestination({ id: 'proj_123', name: 'Customer portal' }),
      { href: '/projects/proj_123', label: 'Customer portal' },
    );
  });
});
