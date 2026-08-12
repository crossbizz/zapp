import { describe, expect, it } from 'vitest';

import { TemplateRegistryConfigSchema } from '../src/templates.js';

const VALID_TEMPLATE = {
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

function registryWith(template: unknown = VALID_TEMPLATE): unknown {
  return { version: 1, templates: [template] };
}

describe('TemplateRegistryConfigSchema', () => {
  it('accepts an approved template pinned to an immutable commit', () => {
    expect(TemplateRegistryConfigSchema.parse(registryWith())).toEqual(registryWith());
  });

  it('rejects unapproved sources and mutable source identities', () => {
    expect(
      TemplateRegistryConfigSchema.safeParse(
        registryWith({ ...VALID_TEMPLATE, source: { ...VALID_TEMPLATE.source, approved: false } }),
      ).success,
    ).toBe(false);
    expect(
      TemplateRegistryConfigSchema.safeParse(
        registryWith({
          ...VALID_TEMPLATE,
          source: { ...VALID_TEMPLATE.source, commitSha: 'main' },
        }),
      ).success,
    ).toBe(false);
    expect(
      TemplateRegistryConfigSchema.safeParse(
        registryWith({
          ...VALID_TEMPLATE,
          source: { ...VALID_TEMPLATE.source, branch: 'main' },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects duplicate and non-canonical slugs', () => {
    expect(
      TemplateRegistryConfigSchema.safeParse({
        version: 1,
        templates: [VALID_TEMPLATE, { ...VALID_TEMPLATE }],
      }).success,
    ).toBe(false);
    expect(
      TemplateRegistryConfigSchema.safeParse(
        registryWith({ ...VALID_TEMPLATE, slug: 'SaaS Starter' }),
      ).success,
    ).toBe(false);
  });

  it.each([
    'http://saas-starter.demo.zapp.build',
    'https://localhost:3000',
    'https://127.0.0.1',
    'https://[::ffff:7f00:1]',
    'https://example.com',
    'https://saas-starter.demo.zapp.build:8443',
  ])('rejects unsafe demo URL %s', (demoUrl) => {
    expect(
      TemplateRegistryConfigSchema.safeParse(registryWith({ ...VALID_TEMPLATE, demoUrl })).success,
    ).toBe(false);
  });

  it('rejects a demo URL containing user information', () => {
    const demoUrl = new URL(VALID_TEMPLATE.demoUrl);
    demoUrl.username = 'present';
    expect(
      TemplateRegistryConfigSchema.safeParse(
        registryWith({ ...VALID_TEMPLATE, demoUrl: demoUrl.toString() }),
      ).success,
    ).toBe(false);
  });

  it('requires complete, bounded presentation metadata', () => {
    const withoutHighlights: Record<string, unknown> = { ...VALID_TEMPLATE };
    delete withoutHighlights['highlights'];
    expect(TemplateRegistryConfigSchema.safeParse(registryWith(withoutHighlights)).success).toBe(
      false,
    );
    expect(
      TemplateRegistryConfigSchema.safeParse(registryWith({ ...VALID_TEMPLATE, pagesIncluded: [] }))
        .success,
    ).toBe(false);
    expect(
      TemplateRegistryConfigSchema.safeParse(
        registryWith({ ...VALID_TEMPLATE, description: 'x'.repeat(501) }),
      ).success,
    ).toBe(false);
  });
});
