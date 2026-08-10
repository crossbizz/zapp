import { z } from 'zod';

export const ModalEnvironmentSchema = z.enum(['zapp-dev', 'zapp-staging', 'zapp-prod']);
export type ModalEnvironment = z.infer<typeof ModalEnvironmentSchema>;

export const ModalAppNameSchema = z.enum(['zapp-workspaces', 'zapp-browser-verify']);
export type ModalAppName = z.infer<typeof ModalAppNameSchema>;

export const ImageNameSchema = z.enum(['forge-node-base', 'forge-web-test']);
export type ImageName = z.infer<typeof ImageNameSchema>;

export const ImmutableImageTagSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}-[a-f0-9]{7}$/u, 'Expected YYYY-MM-DD-{gitsha7}');
export type ImmutableImageTag = z.infer<typeof ImmutableImageTagSchema>;

export const ImageDigestSchema = z
  .string()
  .regex(/^im-[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'Expected an immutable image digest');
export type ImageDigest = z.infer<typeof ImageDigestSchema>;

const RegistryImageRefSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/u,
    'Expected a registry image pinned by sha256 digest',
  )
  .refine((value) => !value.toLowerCase().includes('latest'), 'latest is not immutable');

export const ImageBaseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registry'), ref: RegistryImageRefSchema }).strict(),
  z.object({ kind: z.literal('publication'), digest: ImageDigestSchema }).strict(),
]);
export type ImageBase = z.infer<typeof ImageBaseSchema>;

export const ImageFileSchema = z
  .object({
    path: z.string().regex(/^\/[A-Za-z0-9._/-]+$/u, 'Expected an absolute image path'),
    mode: z.string().regex(/^0[0-7]{3}$/u, 'Expected an octal file mode'),
    contents: z.string(),
  })
  .strict();
export type ImageFile = z.infer<typeof ImageFileSchema>;

export const SourceFetchRevisionSchema = z
  .object({
    repositoryUrl: z
      .string()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u,
        'Expected an immutable-source GitHub HTTPS repository URL',
      ),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/u, 'Expected a full Git commit SHA'),
  })
  .strict();
export type SourceFetchRevision = z.infer<typeof SourceFetchRevisionSchema>;

export const ImageBuildLayerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plain'), commands: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ kind: z.literal('source-fetch'), source: SourceFetchRevisionSchema }).strict(),
]);
export type ImageBuildLayer = z.infer<typeof ImageBuildLayerSchema>;

export const ImageRecipeSchema = z
  .object({
    imageName: ImageNameSchema,
    base: ImageBaseSchema,
    layers: z.array(ImageBuildLayerSchema).min(1),
    files: z.array(ImageFileSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const sourceLayerIndexes = value.layers.flatMap((layer, index) =>
      layer.kind === 'source-fetch' ? [index] : [],
    );
    if (sourceLayerIndexes.length > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layers'],
        message: 'A recipe can contain only one source-fetch layer',
      });
    }
    const sourceLayerIndex = sourceLayerIndexes[0];
    if (
      sourceLayerIndex !== undefined &&
      value.layers[sourceLayerIndex + 1]?.kind !== 'plain'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['layers', sourceLayerIndex + 1],
        message: 'A source-fetch layer must be followed by a plain verification layer',
      });
    }
  });
export type ImageRecipe = z.infer<typeof ImageRecipeSchema>;

export const PublishedImageNameSchema = z
  .string()
  .regex(
    /^(forge-node-base|forge-web-test):\d{4}-\d{2}-\d{2}-[a-f0-9]{7}$/u,
    'Expected an immutable published image name',
  );

export const PublishImageInputSchema = z
  .object({
    environment: ModalEnvironmentSchema,
    appName: ModalAppNameSchema,
    imageName: ImageNameSchema,
    tag: ImmutableImageTagSchema,
    publishedName: PublishedImageNameSchema,
    recipe: ImageRecipeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.publishedName.startsWith(`${value.imageName}:`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishedName'],
        message: 'Published image name must match imageName',
      });
    }
    if (!value.publishedName.endsWith(`:${value.tag}`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishedName'],
        message: 'Published image name must carry tag',
      });
    }
    if (value.recipe.imageName !== value.imageName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipe', 'imageName'],
        message: 'Recipe image name must match publication target',
      });
    }
  });
export type PublishImageInput = z.infer<typeof PublishImageInputSchema>;

export const PublishedImageSchema = z
  .object({
    digest: ImageDigestSchema,
    publishedName: PublishedImageNameSchema,
  })
  .strict();
export type PublishedImage = z.infer<typeof PublishedImageSchema>;

export const SmokeImageInputSchema = z
  .object({
    environment: ModalEnvironmentSchema,
    appName: z.literal('zapp-workspaces'),
    digest: ImageDigestSchema,
    publishedName: PublishedImageNameSchema.refine(
      (value) => value.startsWith('forge-node-base:'),
      'Smoke requires forge-node-base',
    ),
    agentToken: z.string().min(1),
    telemetryEndpoint: z
      .string()
      .url()
      .superRefine((value, context) => {
        const url = new URL(value);
        if (url.protocol !== 'https:') {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Telemetry requires HTTPS' });
        }
        if (url.username !== '' || url.password !== '') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Telemetry URL cannot contain userinfo',
          });
        }
        if (url.search !== '') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Telemetry URL cannot contain query parameters',
          });
        }
        if (url.hash !== '') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Telemetry URL cannot contain a fragment',
          });
        }
      })
      .optional(),
  })
  .strict();
export type SmokeImageInput = z.infer<typeof SmokeImageInputSchema>;

export const SandboxTagsSchema = z
  .object({
    org_id: z.string().min(1),
    project_id: z.string().min(1),
    branch_id: z.string().min(1),
    run_id: z.string().min(1),
    task_id: z.string().min(1),
    purpose: z.string().min(1),
    environment: ModalEnvironmentSchema,
  })
  .strict();
export type SandboxTags = z.infer<typeof SandboxTagsSchema>;

export const AgentHealthSchema = z
  .object({
    ok: z.literal(true),
    details: z.string().min(1),
    devServer: z
      .object({
        port: z.number().int().min(1).max(65_535),
        pid: z.number().int().positive(),
        supervisorId: z.string().min(1),
        owned: z.boolean(),
        httpReady: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const ImageSmokeEvidenceSchema = z
  .object({
    nodeVersion: z.string().regex(/^v22\./u),
    health: AgentHealthSchema,
    vmRuntime: z.literal(true),
    cgroup: z
      .object({
        delegated: z.literal(true),
        kill: z.literal(true),
        emptySignal: z.literal(true),
      })
      .strict(),
    lifecycle: z
      .object({
        timeout: z.object({ buffered: z.literal(true), pty: z.literal(true) }).strict(),
        disconnect: z.object({ buffered: z.literal(true), pty: z.literal(true) }).strict(),
        explicitKill: z.object({ buffered: z.literal(true), pty: z.literal(true) }).strict(),
        agentShutdown: z.object({ buffered: z.literal(true), pty: z.literal(true) }).strict(),
        pidOwnership: z.literal(true),
      })
      .strict(),
    capabilities: z
      .object({
        previewProxyHealth: z.literal(true),
        volumeReadWrite: z.literal(true),
        filesystemSnapshot: ImageDigestSchema,
        encryptedTunnel: z.literal(true),
        readinessProbe: z.literal(true),
        gitleaksSecretScan: z.literal(true),
        antiSlopToolchain: z.literal(true),
      })
      .strict(),
    credentialAbsence: z
      .object({
        environment: z.literal(true),
        gitConfiguration: z.literal(true),
        askpassPath: z.literal(true),
        processEnvironment: z.literal(true),
      })
      .strict(),
    terminated: z.literal(true),
  })
  .strict();
export type ImageSmokeEvidence = z.infer<typeof ImageSmokeEvidenceSchema>;

export const VerifyPublishedImageInputSchema = z
  .object({
    environment: ModalEnvironmentSchema,
    digest: ImageDigestSchema,
    publishedName: PublishedImageNameSchema,
  })
  .strict();
export type VerifyPublishedImageInput = z.infer<typeof VerifyPublishedImageInputSchema>;

export const ModalCredentialsSchema = z
  .object({
    tokenId: z.string().min(1),
    tokenSecret: z.string().min(1),
  })
  .strict();
export type ModalCredentials = z.infer<typeof ModalCredentialsSchema>;

export interface ModalImagePublisher {
  publishImage(input: PublishImageInput): Promise<PublishedImage>;
  smokeImage(input: SmokeImageInput): Promise<ImageSmokeEvidence>;
  verifyPublishedImage(input: VerifyPublishedImageInput): Promise<void>;
}
