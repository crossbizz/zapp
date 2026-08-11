import { z } from 'zod';

export interface SupabaseTypegenRuntime {
  exec(input: {
    readonly cmd: string;
    readonly args: string[];
    readonly env?: Record<string, string>;
    readonly timeoutMs: number;
  }): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
  }>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

const ColumnSchema = z
  .object({
    name: z.string().trim().min(1),
    dataType: z.string().trim().min(1),
    nullable: z.boolean(),
  })
  .strict();
const TableSchema = z
  .object({
    id: z.number().int().nonnegative(),
    schema: z.string().trim().min(1),
    name: z.string().trim().min(1),
    columns: z.array(ColumnSchema),
  })
  .strict();
const SchemaInputSchema = z
  .object({
    projectRef: z.string().trim().min(1).max(200),
    accessToken: z.string().trim().min(1).max(10_000),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();
const SchemaResultSchema = z
  .object({ dialect: z.literal('postgresql'), tables: z.array(TableSchema) })
  .strict();
const TypegenInputSchema = z
  .object({
    projectRef: z.string().trim().min(1).max(200),
    accessToken: z.string().trim().min(1).max(10_000),
    outputPath: z.string().trim().min(1),
  })
  .strict();

export type SupabaseTable = z.infer<typeof TableSchema>;
export type SupabaseSchemaResult = z.infer<typeof SchemaResultSchema>;

export interface SupabaseSchemaPort {
  readTables(input: z.input<typeof SchemaInputSchema>): Promise<readonly SupabaseTable[]>;
}

const PostgresMetaColumnSchema = z.object({
  name: z.string().trim().min(1),
  data_type: z.string().trim().min(1),
  is_nullable: z.boolean(),
});
const PostgresMetaTableSchema = z.object({
  id: z.number().int().nonnegative(),
  schema: z.string().trim().min(1),
  name: z.string().trim().min(1),
  columns: z.array(PostgresMetaColumnSchema).default([]),
});

interface PostgresMetaOptions {
  readonly baseUrl?: (projectRef: string) => string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createPostgresMetaClient(options: PostgresMetaOptions = {}): SupabaseSchemaPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl =
    options.baseUrl ?? ((projectRef: string) => `https://${projectRef}.supabase.co/pg-meta`);
  return {
    async readTables(rawInput) {
      const input = SchemaInputSchema.parse(rawInput);
      const response = await fetchImpl(
        `${baseUrl(input.projectRef).replace(/\/$/u, '')}/tables?included_schemas=public`,
        {
          headers: { authorization: `Bearer ${input.accessToken}` },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      if (!response.ok) {
        throw new Error(`postgres-meta request failed with status ${String(response.status)}`);
      }
      return z
        .array(PostgresMetaTableSchema)
        .parse(await response.json())
        .map((table) =>
          TableSchema.parse({
            id: table.id,
            schema: table.schema,
            name: table.name,
            columns: table.columns.map((column) => ({
              name: column.name,
              dataType: column.data_type,
              nullable: column.is_nullable,
            })),
          }),
        );
    },
  };
}

export async function readSupabaseSchema(
  port: SupabaseSchemaPort,
  rawInput: z.input<typeof SchemaInputSchema>,
): Promise<SupabaseSchemaResult> {
  const input = SchemaInputSchema.parse(rawInput);
  return SchemaResultSchema.parse({ dialect: 'postgresql', tables: await port.readTables(input) });
}

export async function generateSupabaseTypes(
  rawInput: z.input<typeof TypegenInputSchema> & { readonly runtime: SupabaseTypegenRuntime },
): Promise<{ readonly path: string; readonly bytes: number }> {
  const input = TypegenInputSchema.parse({
    projectRef: rawInput.projectRef,
    accessToken: rawInput.accessToken,
    outputPath: rawInput.outputPath,
  });
  const result = await rawInput.runtime.exec({
    cmd: 'supabase',
    args: ['gen', 'types', 'typescript', '--project-id', input.projectRef, '--schema', 'public'],
    env: { SUPABASE_ACCESS_TOKEN: input.accessToken },
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Supabase type generation failed with exit code ${String(result.exitCode)}`);
  }
  const artifact = new TextEncoder().encode(result.stdout);
  if (artifact.byteLength === 0) {
    throw new Error('Supabase type generation produced an empty artifact');
  }
  await rawInput.runtime.writeFile(input.outputPath, artifact);
  return { path: input.outputPath, bytes: artifact.byteLength };
}
