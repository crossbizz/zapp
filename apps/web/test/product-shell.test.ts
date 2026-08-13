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
import { toProjectCardView } from '../src/components/projects/project-card-view.js';
import {
  decodeThumbnail,
  revokeThumbnail,
} from '../src/components/projects/project-thumbnail.js';

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

const project = {
  archivedAt: null,
  createdAt: '2026-08-13T18:00:00.000Z',
  createdBy: 'user_123',
  description: null,
  id: 'proj_123',
  name: 'Customer portal',
  organizationId: 'org_alpha',
  slug: 'customer-portal',
  sourceType: 'prompt',
  supportLevel: 'verified',
} as const;

function summary(
  preview: 'failed' | 'not_started' | 'ready' | 'starting',
  production: 'deploying' | 'failed' | 'healthy' | 'not_deployed',
) {
  return {
    deployReadiness: {
      findings: [],
      releaseId: 'rel_123',
      state: 'warnings' as const,
    },
    lastActivityAt: '2026-08-13T18:04:00.000Z',
    preview: { occurredAt: '2026-08-13T18:02:00.000Z', status: preview },
    previewThumbnail: {
      alt: 'Preview of Customer portal',
      artifactId: 'art_123',
      capturedAt: '2026-08-13T18:03:00.000Z',
      contentHash: 'b'.repeat(64),
    },
    production: {
      occurredAt: '2026-08-13T18:03:00.000Z',
      releaseId: 'rel_123',
      status: production,
    },
    projectId: 'proj_123',
  };
}

void describe('project card projection', () => {
  void it('maps every live environment state to explicit text', () => {
    const cases = [
      ['not_started', 'not_deployed', 'Not started', 'Not deployed'],
      ['starting', 'deploying', 'Starting', 'Deploying'],
      ['ready', 'healthy', 'Ready', 'Healthy'],
      ['failed', 'failed', 'Failed', 'Failed'],
    ] as const;

    for (const [preview, production, previewLabel, productionLabel] of cases) {
      const view = toProjectCardView(project, summary(preview, production));
      assert.equal(view.preview.label, previewLabel);
      assert.equal(view.production.label, productionLabel);
      assert.equal(view.readiness.label, 'Warnings');
    }
  });

  void it('keeps missing activity and thumbnail states explicit', () => {
    const value = summary('not_started', 'not_deployed');
    const view = toProjectCardView(project, {
      ...value,
      deployReadiness: null,
      lastActivityAt: null,
      previewThumbnail: null,
    });

    assert.equal(view.activity.label, 'No activity yet');
    assert.equal(view.activity.dateTime, null);
    assert.equal(view.readiness.label, 'Unavailable');
    assert.equal(view.thumbnail, null);
  });
});

void describe('project thumbnail lifecycle', () => {
  void it('decodes only an allowed image MIME type', async () => {
    const blob = decodeThumbnail({
      thumbnail: {
        content: 'aGVsbG8=',
        contentHash: 'b'.repeat(64),
        contentType: 'image/png',
        encoding: 'base64',
      },
    });

    assert.equal(blob.type, 'image/png');
    assert.equal(await blob.text(), 'hello');
    assert.throws(() => decodeThumbnail({
      thumbnail: {
        content: 'aGVsbG8=',
        contentHash: 'b'.repeat(64),
        contentType: 'text/html',
        encoding: 'base64',
      },
    }));
  });

  void it('revokes replaced object URLs through the supplied browser primitive', () => {
    const revoked: string[] = [];
    revokeThumbnail('blob:preview-1', (url) => revoked.push(url));
    assert.deepEqual(revoked, ['blob:preview-1']);
  });
});
