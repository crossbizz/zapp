import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  TemplateRegistrySchema,
  createTemplateRegistry,
  loadTemplateRegistryFile,
} from '../src/templates.js';

const VALID = {
  slug: 'next-starter',
  name: 'Next.js Starter',
  description: 'A production-ready Next.js starting point.',
  pagesIncluded: ['Home'],
  highlights: ['TypeScript included'],
  demoUrl: 'https://templates.zapp.build/next-starter/a57bb2926674/',
  stack: ['Next.js', 'React', 'TypeScript'],
  repoRef: 'https://github.com/dyad-sh/nextjs-template.git',
  commitSha: 'a57bb2926674275a84f651c64e5c995a42519b5e',
};

describe('GIT-6 approved template registry', () => {
  it('rejects duplicate slugs, mutable/unsafe sources, and unsafe demo URLs', () => {
    expect(() => TemplateRegistrySchema.parse([VALID, VALID])).toThrow(/slug/iu);
    expect(() => TemplateRegistrySchema.parse([{ ...VALID, commitSha: 'main' }])).toThrow();
    expect(() => TemplateRegistrySchema.parse([{
      ...VALID,
      repoRef: 'https://token@github.com/dyad-sh/nextjs-template.git',
    }])).toThrow();
    expect(() => TemplateRegistrySchema.parse([{
      ...VALID,
      repoRef: 'https://example.com/unapproved/template.git',
    }])).toThrow();
    expect(() => TemplateRegistrySchema.parse([{
      ...VALID,
      demoUrl: 'javascript:alert(1)',
    }])).toThrow();
    expect(() => TemplateRegistrySchema.parse([{
      ...VALID,
      demoUrl: 'https://templates.zapp.build/next-starter/?token=secret',
    }])).toThrow();
  });

  it('loads the checked-in releases and structurally omits source identity publicly', async () => {
    const source = new URL('../../../config/templates.json', import.meta.url);
    const registry = await loadTemplateRegistryFile(source);

    expect(registry.listPublic().map(({ slug }) => slug)).toEqual([
      'next-starter',
      'react-vite-fullstack',
      'mini-store',
    ]);
    expect(registry.getApproved('next-starter')).toMatchObject({
      repoRef: 'https://github.com/dyad-sh/nextjs-template.git',
      commitSha: 'a57bb2926674275a84f651c64e5c995a42519b5e',
    });
    expect(JSON.stringify(registry.listPublic())).not.toMatch(/repoRef|commitSha|github\.com/iu);
    expect(JSON.parse(await readFile(source, 'utf8'))).toHaveLength(3);
  });

  it('returns stable misses without weakening the strict public projection', () => {
    const registry = createTemplateRegistry([VALID]);
    expect(registry.getApproved('missing')).toBeUndefined();
    expect(registry.getPublic('next-starter')).toEqual({
      slug: VALID.slug,
      name: VALID.name,
      description: VALID.description,
      pagesIncluded: VALID.pagesIncluded,
      highlights: VALID.highlights,
      demoUrl: VALID.demoUrl,
      stack: VALID.stack,
    });
  });
});
