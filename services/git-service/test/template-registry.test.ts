import { describe, expect, it } from 'vitest';

import { createTemplateRegistry, loadTemplateRegistry } from '../src/template-registry.js';

const TEMPLATE = {
  slug: 'saas-starter',
  name: 'SaaS Starter',
  description: 'A production-shaped SaaS application with authentication and billing.',
  pagesIncluded: ['Landing', 'Dashboard', 'Settings'],
  highlights: ['Auth pre-built', 'Billing included'],
  demoUrl: 'https://saas-starter.demo.zapp.build',
  stack: 'Next.js, TypeScript, Tailwind CSS',
  source: {
    approved: true,
    repoRef: 'zapp-projects/saas-starter',
    commitSha: '0123456789abcdef0123456789abcdef01234567',
  },
} as const;

describe('approved template registry', () => {
  it('resolves only a registry slug to its server-side immutable source', () => {
    const registry = createTemplateRegistry({ version: 1, templates: [TEMPLATE] });

    expect(registry.resolveApprovedSource('saas-starter')).toEqual(TEMPLATE.source);
    expect(registry.resolveApprovedSource('caller-supplied/repository')).toBeUndefined();
  });

  it('projects presentation metadata without serializing the internal repository ref', () => {
    const registry = createTemplateRegistry({ version: 1, templates: [TEMPLATE] });

    const publicTemplates = registry.listPublic();
    expect(publicTemplates).toEqual([
      {
        slug: TEMPLATE.slug,
        name: TEMPLATE.name,
        description: TEMPLATE.description,
        pagesIncluded: TEMPLATE.pagesIncluded,
        highlights: TEMPLATE.highlights,
        demoUrl: TEMPLATE.demoUrl,
        stack: TEMPLATE.stack,
      },
    ]);
    expect(JSON.stringify(publicTemplates)).not.toContain('repoRef');
    expect(JSON.stringify(registry.findPublic('saas-starter'))).not.toContain('source');
  });

  it('loads and validates the checked-in registry', async () => {
    const registry = await loadTemplateRegistry();

    expect(registry.listPublic().length).toBeGreaterThan(0);
    for (const template of registry.listPublic()) {
      expect(registry.resolveApprovedSource(template.slug)?.commitSha).toMatch(/^[0-9a-f]{40}$/u);
    }
  });
});
