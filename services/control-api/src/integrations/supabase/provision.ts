import { z } from 'zod';

const ProjectSchema = z.object({ ref: z.string().trim().min(1) });
const ApiKeySchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(['legacy', 'publishable', 'secret']).nullable().optional(),
  api_key: z.string().trim().min(1).nullable().optional(),
});

const ConnectExistingInputSchema = z
  .object({
    projectRef: z.string().trim().min(1).max(200),
    accessToken: z.string().trim().min(1).max(10_000),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

const ProvisionInputSchema = z.discriminatedUnion('planAllowsProvision', [
  z
    .object({
      accessToken: z.string().trim().min(1).max(10_000),
      organizationSlug: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200),
      region: z.string().trim().min(1).max(100),
      planAllowsProvision: z.literal(false),
    })
    .strict(),
  z
    .object({
      accessToken: z.string().trim().min(1).max(10_000),
      organizationSlug: z.string().trim().min(1).max(200),
      name: z.string().trim().min(1).max(200),
      region: z.string().trim().min(1).max(100),
      databasePassword: z.string().min(16).max(1_000),
      planAllowsProvision: z.literal(true),
    })
    .strict(),
]);

const ConnectedProjectSchema = z
  .object({
    projectRef: z.string().trim().min(1),
    url: z.string().url(),
    anonKey: z.string().trim().min(1),
  })
  .strict();

const ProvisionResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('connect_existing_required') }).strict(),
  z.object({ outcome: z.literal('provisioned'), projectRef: z.string().trim().min(1) }).strict(),
]);

export type SupabaseConnectedProject = z.infer<typeof ConnectedProjectSchema>;

export interface SupabaseManagementPort {
  connectExisting(
    input: z.input<typeof ConnectExistingInputSchema>,
  ): Promise<SupabaseConnectedProject>;
}

export interface SupabaseProvisioningPort {
  createDevelopmentProject(input: {
    readonly accessToken: string;
    readonly organizationSlug: string;
    readonly name: string;
    readonly region: string;
    readonly databasePassword: string;
  }): Promise<{ readonly projectRef: string }>;
}

export class SupabaseManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseManagementError';
  }
}

interface ManagementClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createSupabaseManagementClient(
  options: ManagementClientOptions = {},
): SupabaseManagementPort & SupabaseProvisioningPort {
  const baseUrl = (options.baseUrl ?? 'https://api.supabase.com/v1').replace(/\/$/u, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request(path: string, accessToken: string, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    headers.set('content-type', 'application/json');
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new SupabaseManagementError(
        `Supabase Management API request failed with status ${String(response.status)}`,
      );
    }
    return await response.json();
  }

  return {
    async connectExisting(rawInput) {
      const input = ConnectExistingInputSchema.parse(rawInput);
      const [projectValue, keyValue] = await Promise.all([
        request(`/projects/${encodeURIComponent(input.projectRef)}`, input.accessToken, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
        request(`/projects/${encodeURIComponent(input.projectRef)}/api-keys`, input.accessToken, {
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      ]);
      const project = ProjectSchema.parse(projectValue);
      if (project.ref !== input.projectRef) {
        throw new SupabaseManagementError('Supabase returned a different project');
      }
      const keys = z.array(ApiKeySchema).parse(keyValue);
      const anon =
        keys.find(
          (key) => key.name === 'anon' && key.api_key !== null && key.api_key !== undefined,
        ) ??
        keys.find(
          (key) => key.type === 'publishable' && key.api_key !== null && key.api_key !== undefined,
        );
      if (anon === undefined) {
        throw new SupabaseManagementError('Supabase project has no anonymous API key');
      }
      return ConnectedProjectSchema.parse({
        projectRef: project.ref,
        url: `https://${project.ref}.supabase.co`,
        anonKey: anon.api_key,
      });
    },

    async createDevelopmentProject(input) {
      const result = ProjectSchema.parse(
        await request('/projects', input.accessToken, {
          method: 'POST',
          body: JSON.stringify({
            organization_slug: input.organizationSlug,
            name: input.name,
            region_selection: { type: 'specific', code: input.region },
            db_pass: input.databasePassword,
          }),
        }),
      );
      return { projectRef: result.ref };
    },
  };
}

export async function provisionDevelopmentProject(
  provider: SupabaseProvisioningPort,
  rawInput: z.input<typeof ProvisionInputSchema>,
): Promise<z.infer<typeof ProvisionResultSchema>> {
  const input = ProvisionInputSchema.parse(rawInput);
  if (!input.planAllowsProvision) {
    return { outcome: 'connect_existing_required' };
  }
  const created = await provider.createDevelopmentProject(input);
  return ProvisionResultSchema.parse({ outcome: 'provisioned', projectRef: created.projectRef });
}
