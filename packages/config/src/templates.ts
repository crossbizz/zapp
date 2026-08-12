import { readFile } from 'node:fs/promises';

import { z } from 'zod';
import { CommitShaSchema } from '@zapp/contracts';

const TemplateSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(80);
const PresentationTextSchema = z.string().trim().min(1).max(500);
const PresentationListSchema = z.array(PresentationTextSchema).min(1).max(30);
const RepoRefSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u.test(url.pathname)
  ) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid approved repository ref' });
});
const TemplateDemoUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'templates.zapp.build' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid template demo URL' });
});

export const TemplateRegistryEntrySchema = z.object({
  slug: TemplateSlugSchema,
  name: PresentationTextSchema,
  description: PresentationTextSchema,
  pagesIncluded: PresentationListSchema,
  highlights: PresentationListSchema,
  demoUrl: TemplateDemoUrlSchema,
  stack: PresentationListSchema,
  repoRef: RepoRefSchema,
  commitSha: CommitShaSchema,
}).strict();
export type TemplateRegistryEntry = z.infer<typeof TemplateRegistryEntrySchema>;

export const PublicTemplateSchema = TemplateRegistryEntrySchema.omit({
  repoRef: true,
  commitSha: true,
}).strict();
export type PublicTemplate = z.infer<typeof PublicTemplateSchema>;

export const TemplateRegistrySchema = z.array(TemplateRegistryEntrySchema).min(1).max(100)
  .superRefine((entries, context) => {
    const slugs = new Set<string>();
    const sources = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (slugs.has(entry.slug)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'slug'], message: 'Duplicate template slug' });
      }
      slugs.add(entry.slug);
      const source = `${entry.repoRef}@${entry.commitSha}`;
      if (sources.has(source)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'repoRef'], message: 'Duplicate template source identity' });
      }
      sources.add(source);
    }
  });

function toPublic(entry: TemplateRegistryEntry): PublicTemplate {
  return PublicTemplateSchema.parse({
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    pagesIncluded: entry.pagesIncluded,
    highlights: entry.highlights,
    demoUrl: entry.demoUrl,
    stack: entry.stack,
  });
}

export function createTemplateRegistry(input: unknown) {
  const entries = TemplateRegistrySchema.parse(input);
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const publicEntries = entries.map(toPublic);
  const publicBySlug = new Map(publicEntries.map((entry) => [entry.slug, entry]));
  return {
    listPublic: (): readonly PublicTemplate[] => publicEntries,
    getPublic: (slug: string): PublicTemplate | undefined => publicBySlug.get(slug),
    getApproved: (slug: string): TemplateRegistryEntry | undefined => bySlug.get(slug),
  };
}

export async function loadTemplateRegistryFile(source: URL) {
  return createTemplateRegistry(JSON.parse(await readFile(source, 'utf8')) as unknown);
}
