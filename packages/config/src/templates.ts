import { CommitShaSchema, HttpsUrlSchema } from '@zapp/contracts';
import { z } from 'zod';

const TemplateSlugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Template slug must be canonical kebab-case');

const TEMPLATE_DEMO_HOST_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.demo\.zapp\.build$/;

export const TemplateDemoUrlSchema = HttpsUrlSchema.max(2_048).superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.username !== '' || url.password !== '') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Demo URL cannot include credentials',
    });
  }
  if (!TEMPLATE_DEMO_HOST_PATTERN.test(url.hostname) || url.port !== '') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Demo URL must use an approved zapp template demo origin',
    });
  }
});

const PresentationLabelSchema = z.string().trim().min(1).max(80);

function uniquePresentationList(maximum: number) {
  return z
    .array(PresentationLabelSchema)
    .min(1)
    .max(maximum)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        const key = value.toLowerCase();
        if (seen.has(key)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Presentation values must be unique',
            path: [index],
          });
        }
        seen.add(key);
      }
    });
}

export const ApprovedTemplateSourceSchema = z
  .object({
    approved: z.literal(true),
    repoRef: z
      .string()
      .regex(
        /^zapp-projects\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'Template source must be in the platform-owned zapp-projects namespace',
      ),
    commitSha: CommitShaSchema,
  })
  .strict();

const PublicTemplateShape = {
  slug: TemplateSlugSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  pagesIncluded: uniquePresentationList(20),
  highlights: uniquePresentationList(20),
  demoUrl: TemplateDemoUrlSchema,
  stack: z.string().trim().min(1).max(200),
} as const;

export const PublicTemplateDefinitionSchema = z.object(PublicTemplateShape).strict();

export const ServerTemplateDefinitionSchema = PublicTemplateDefinitionSchema.extend({
  source: ApprovedTemplateSourceSchema,
}).strict();

export const TemplateRegistryConfigSchema = z
  .object({
    version: z.literal(1),
    templates: z.array(ServerTemplateDefinitionSchema).min(1).max(100),
  })
  .strict()
  .superRefine((registry, context) => {
    const seen = new Set<string>();
    for (const [index, template] of registry.templates.entries()) {
      if (seen.has(template.slug)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Template slugs must be unique',
          path: ['templates', index, 'slug'],
        });
      }
      seen.add(template.slug);
    }
  });

export type ApprovedTemplateSource = z.infer<typeof ApprovedTemplateSourceSchema>;
export type PublicTemplateDefinition = z.infer<typeof PublicTemplateDefinitionSchema>;
export type ServerTemplateDefinition = z.infer<typeof ServerTemplateDefinitionSchema>;
export type TemplateRegistryConfig = z.infer<typeof TemplateRegistryConfigSchema>;

export function publicTemplateDefinition(
  template: ServerTemplateDefinition,
): PublicTemplateDefinition {
  return PublicTemplateDefinitionSchema.parse({
    slug: template.slug,
    name: template.name,
    description: template.description,
    pagesIncluded: template.pagesIncluded,
    highlights: template.highlights,
    demoUrl: template.demoUrl,
    stack: template.stack,
  });
}
