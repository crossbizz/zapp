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
const PythonWheelUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'files.pythonhosted.org' &&
      url.username === '' &&
      url.password === ''
    );
  }, 'Expected an unauthenticated files.pythonhosted.org HTTPS wheel URL');
const OsvNpmDatabaseUrlSchema = z
  .string()
  .regex(
    /^https:\/\/storage\.googleapis\.com\/download\/storage\/v1\/b\/osv-vulnerabilities\/o\/npm%2Fall\.zip\?generation=\d+&alt=media$/u,
    'Expected an immutable npm OSV database generation URL',
  );

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
        osvScanner: z
          .object({
            version: ExactVersionSchema,
            linuxX64Sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            npmDatabaseUrl: OsvNpmDatabaseUrlSchema,
            npmDatabaseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
        antiSlop: z
          .object({
            semgrep: z
              .object({
                version: ExactVersionSchema,
                linuxX64WheelUrl: PythonWheelUrlSchema,
                linuxX64Sha256: z.string().regex(/^[a-f0-9]{64}$/u),
              })
              .strict(),
            knip: ExactVersionSchema,
            jscpd: ExactVersionSchema,
            eslint: ExactVersionSchema,
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
