import { z } from 'zod';
import rawImageBuildConfig from '../image-config.json' with { type: 'json' };

const ExactVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/u, 'Expected an exact semantic version');
const RegistryImageRefSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/u,
    'Expected a registry image pinned by tag and sha256 digest',
  )
  .refine((value) => !value.toLowerCase().includes('latest'), 'latest is not immutable');

export const ImageBuildConfigSchema = z
  .object({
    version: z.literal(1),
    node: z
      .object({
        baseImage: RegistryImageRefSchema,
        debianSnapshot: z
          .string()
          .regex(/^\d{8}T\d{6}Z$/u, 'Expected a timestamped Debian snapshot'),
        packageManagers: z
          .object({
            pnpm: ExactVersionSchema,
            yarn: ExactVersionSchema,
          })
          .strict(),
        gitleaks: z
          .object({
            version: ExactVersionSchema,
            linuxX64Sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      })
      .strict(),
    webTest: z
      .object({
        packageName: z.string().regex(/^[a-z0-9-]+$/u),
        packageVersion: ExactVersionSchema,
        playwright: ExactVersionSchema,
        axeCoreCli: ExactVersionSchema,
      })
      .strict(),
  })
  .strict();
export type ImageBuildConfig = z.infer<typeof ImageBuildConfigSchema>;

export const IMAGE_BUILD_CONFIG = ImageBuildConfigSchema.parse(rawImageBuildConfig);
