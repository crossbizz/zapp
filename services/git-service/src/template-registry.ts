import {
  TemplateRegistryConfigSchema,
  publicTemplateDefinition,
  type ApprovedTemplateSource,
  type PublicTemplateDefinition,
} from '@zapp/config/templates';
import { readFile } from 'node:fs/promises';

export interface ApprovedTemplateRegistry {
  listPublic(): readonly PublicTemplateDefinition[];
  findPublic(slug: string): PublicTemplateDefinition | undefined;
  resolveApprovedSource(slug: string): ApprovedTemplateSource | undefined;
}

function copyPublicTemplate(template: PublicTemplateDefinition): PublicTemplateDefinition {
  return {
    ...template,
    pagesIncluded: [...template.pagesIncluded],
    highlights: [...template.highlights],
  };
}

export function createTemplateRegistry(input: unknown): ApprovedTemplateRegistry {
  const parsed = TemplateRegistryConfigSchema.parse(input);
  const publicTemplates = parsed.templates.map((template) => publicTemplateDefinition(template));
  const publicBySlug = new Map(publicTemplates.map((template) => [template.slug, template]));
  const sourceBySlug = new Map(
    parsed.templates.map((template) => [template.slug, Object.freeze({ ...template.source })]),
  );

  return Object.freeze({
    listPublic: () => publicTemplates.map(copyPublicTemplate),
    findPublic: (slug: string) => {
      const template = publicBySlug.get(slug);
      return template === undefined ? undefined : copyPublicTemplate(template);
    },
    resolveApprovedSource: (slug: string) => sourceBySlug.get(slug),
  });
}

export async function loadTemplateRegistry(
  source: URL = new URL('../../../config/templates.json', import.meta.url),
): Promise<ApprovedTemplateRegistry> {
  const raw: unknown = JSON.parse(await readFile(source, 'utf8'));
  return createTemplateRegistry(raw);
}
