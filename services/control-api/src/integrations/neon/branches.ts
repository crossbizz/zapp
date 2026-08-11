import { createDb } from '@zapp/db';
import { z } from 'zod';

const NeonResourceIdSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9-]+$/u);
const NeonBranchNameSchema = z.string().trim().min(1).max(256);
const NeonApiKeySchema = z.string().trim().min(1).max(10_000);
const SqlIdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z_][a-z0-9_]*$/u);
const ConnectionStringSchema = z.string().url().max(10_000);

const ProjectResponseSchema = z
  .object({ project: z.object({ id: NeonResourceIdSchema }).passthrough() })
  .passthrough();
const BranchSchema = z
  .object({
    id: NeonResourceIdSchema,
    name: NeonBranchNameSchema,
    parent_id: NeonResourceIdSchema.optional(),
    default: z.boolean().optional(),
  })
  .passthrough();
const BranchListResponseSchema = z
  .object({
    branches: z.array(BranchSchema),
    pagination: z
      .object({ next: z.string().min(1).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const BranchResponseSchema = z.object({ branch: BranchSchema }).passthrough();
const DatabaseListResponseSchema = z
  .object({
    databases: z.array(
      z.object({ name: SqlIdentifierSchema, owner_name: SqlIdentifierSchema }).passthrough(),
    ),
  })
  .passthrough();
const ConnectionUriResponseSchema = z.object({ uri: ConnectionStringSchema }).passthrough();

const ProjectRequestSchema = z
  .object({ projectId: NeonResourceIdSchema, apiKey: NeonApiKeySchema })
  .strict();
const CreateBranchInputSchema = ProjectRequestSchema.extend({
  name: NeonBranchNameSchema,
  parentBranchId: NeonResourceIdSchema,
  expiresAt: z.date().optional(),
}).strict();
const DeleteBranchInputSchema = ProjectRequestSchema.extend({
  branchId: NeonResourceIdSchema,
}).strict();
const BranchConnectionInputSchema = DeleteBranchInputSchema.extend({
  databaseName: SqlIdentifierSchema,
}).strict();
const ValidationBranchInputSchema = CreateBranchInputSchema.extend({
  databaseName: SqlIdentifierSchema,
}).strict();

export interface NeonBranch {
  readonly id: string;
  readonly name: string;
  readonly parentBranchId?: string;
  readonly isDefault: boolean;
}

export interface NeonManagementPort {
  getProject(input: z.input<typeof ProjectRequestSchema>): Promise<{ readonly projectId: string }>;
  listBranches(input: z.input<typeof ProjectRequestSchema>): Promise<readonly NeonBranch[]>;
  createBranch(input: z.input<typeof CreateBranchInputSchema>): Promise<NeonBranch>;
  deleteBranch(input: z.input<typeof DeleteBranchInputSchema>): Promise<void>;
  branchConnection(
    input: z.input<typeof BranchConnectionInputSchema>,
  ): Promise<{ readonly databaseName: string; readonly roleName: string; readonly uri: string }>;
}

interface NeonManagementClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`neon_management_failed:${String(response.status)}`);
  return await response.json();
}

function headers(apiKey: string): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${NeonApiKeySchema.parse(apiKey)}`,
    'content-type': 'application/json',
  };
}

function branchView(branch: z.infer<typeof BranchSchema>): NeonBranch {
  return {
    id: branch.id,
    name: branch.name,
    ...(branch.parent_id === undefined ? {} : { parentBranchId: branch.parent_id }),
    isDefault: branch.default ?? false,
  };
}

export function createNeonManagementClient(
  options: NeonManagementClientOptions = {},
): NeonManagementPort {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? 'https://console.neon.tech/api/v2').replace(/\/$/u, '');
  const projectUrl = (projectId: string, suffix = '') =>
    `${baseUrl}/projects/${encodeURIComponent(projectId)}${suffix}`;

  return {
    async getProject(rawInput) {
      const input = ProjectRequestSchema.parse(rawInput);
      const response = await fetchImpl(projectUrl(input.projectId), {
        method: 'GET',
        headers: headers(input.apiKey),
      });
      const parsed = ProjectResponseSchema.parse(await responseJson(response));
      return { projectId: parsed.project.id };
    },

    async listBranches(rawInput) {
      const input = ProjectRequestSchema.parse(rawInput);
      const branches: NeonBranch[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ limit: '400' });
        if (cursor !== undefined) query.set('cursor', cursor);
        const response = await fetchImpl(
          projectUrl(input.projectId, `/branches?${query.toString()}`),
          { method: 'GET', headers: headers(input.apiKey) },
        );
        const page = BranchListResponseSchema.parse(await responseJson(response));
        branches.push(...page.branches.map(branchView));
        const next = page.pagination?.next;
        if (next !== undefined && cursors.has(next)) {
          throw new Error('neon_branch_pagination_cursor_repeated');
        }
        if (next !== undefined) cursors.add(next);
        cursor = next;
      } while (cursor !== undefined);
      return branches;
    },

    async createBranch(rawInput) {
      const input = CreateBranchInputSchema.parse(rawInput);
      const response = await fetchImpl(projectUrl(input.projectId, '/branches'), {
        method: 'POST',
        headers: headers(input.apiKey),
        body: JSON.stringify({
          branch: {
            name: input.name,
            parent_id: input.parentBranchId,
            ...(input.expiresAt === undefined
              ? {}
              : { expires_at: input.expiresAt.toISOString().replace('.000Z', 'Z') }),
          },
          endpoints: [{ type: 'read_write' }],
        }),
      });
      return branchView(BranchResponseSchema.parse(await responseJson(response)).branch);
    },

    async deleteBranch(rawInput) {
      const input = DeleteBranchInputSchema.parse(rawInput);
      const response = await fetchImpl(
        projectUrl(input.projectId, `/branches/${encodeURIComponent(input.branchId)}`),
        { method: 'DELETE', headers: headers(input.apiKey) },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(`neon_management_failed:${String(response.status)}`);
      }
    },

    async branchConnection(rawInput) {
      const input = BranchConnectionInputSchema.parse(rawInput);
      const databasesResponse = await fetchImpl(
        projectUrl(input.projectId, `/branches/${encodeURIComponent(input.branchId)}/databases`),
        { method: 'GET', headers: headers(input.apiKey) },
      );
      const databases = DatabaseListResponseSchema.parse(
        await responseJson(databasesResponse),
      ).databases;
      const database = databases.find((candidate) => candidate.name === input.databaseName);
      if (database === undefined) throw new Error('neon_selected_database_not_found');
      const query = new URLSearchParams({
        branch_id: input.branchId,
        database_name: database.name,
        role_name: database.owner_name,
        pooled: 'false',
      });
      const connectionResponse = await fetchImpl(
        projectUrl(input.projectId, `/connection_uri?${query.toString()}`),
        { method: 'GET', headers: headers(input.apiKey) },
      );
      const connection = ConnectionUriResponseSchema.parse(await responseJson(connectionResponse));
      return { databaseName: database.name, roleName: database.owner_name, uri: connection.uri };
    },
  };
}

export interface NeonSqlPort {
  execute(statement: string): Promise<void>;
  query(statement: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface NeonSqlFactory {
  open(connectionString: string): Promise<NeonSqlPort>;
}

export function createNeonSqlFactory(): NeonSqlFactory {
  return {
    open(rawConnectionString) {
      const connectionString = ConnectionStringSchema.parse(rawConnectionString);
      const database = createDb(connectionString);
      return Promise.resolve({
        execute: async (statement) => {
          await database.sql.unsafe(z.string().min(1).max(2_000_000).parse(statement));
        },
        query: (statement) =>
          database.sql.unsafe(z.string().min(1).max(2_000_000).parse(statement)),
        close: database.close,
      });
    },
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${SqlIdentifierSchema.parse(identifier)}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function configureNeonRoleSeparation(input: {
  readonly sql: NeonSqlPort;
  readonly appRole: string;
  readonly appPassword: string;
}): Promise<void> {
  const appRole = SqlIdentifierSchema.parse(input.appRole);
  const appPassword = z.string().min(20).max(1_000).parse(input.appPassword);
  const role = quoteIdentifier(appRole);
  const password = sqlLiteral(appPassword);
  const rows = z
    .array(z.object({ database_name: SqlIdentifierSchema }).passthrough())
    .min(1)
    .parse(await input.sql.query('select current_database() as database_name'));
  const database = quoteIdentifier(rows[0]?.database_name ?? '');

  await input.sql.execute(`do $zapp$
begin
  if not exists (select 1 from pg_roles where rolname = ${sqlLiteral(appRole)}) then
    create role ${role} login;
  end if;
end
$zapp$;`);
  await input.sql.execute(
    `alter role ${role} with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit password ${password}`,
  );
  await input.sql.execute(`revoke create, temporary on database ${database} from ${role}`);
  await input.sql.execute(`revoke create on schema public from ${role}`);
  await input.sql.execute(`grant connect on database ${database} to ${role}`);
  await input.sql.execute(`grant usage on schema public to ${role}`);
  await input.sql.execute(
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
  );
  await input.sql.execute(`grant usage, select on all sequences in schema public to ${role}`);
  await input.sql.execute(
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${role}`,
  );
  await input.sql.execute(
    `alter default privileges in schema public grant usage, select on sequences to ${role}`,
  );
}

export function connectionStringForRole(input: {
  readonly migrationConnectionString: string;
  readonly appRole: string;
  readonly appPassword: string;
}): string {
  const url = new URL(ConnectionStringSchema.parse(input.migrationConnectionString));
  url.username = SqlIdentifierSchema.parse(input.appRole);
  url.password = z.string().min(20).max(1_000).parse(input.appPassword);
  return url.toString();
}

const SchemaRowSchema = z
  .object({
    table_schema: SqlIdentifierSchema,
    table_name: SqlIdentifierSchema,
    column_name: SqlIdentifierSchema,
    data_type: z.string().min(1),
    is_nullable: z.enum(['YES', 'NO']),
  })
  .passthrough();

export async function readNeonSchema(sql: NeonSqlPort): Promise<{
  readonly dialect: 'postgresql';
  readonly tables: readonly {
    readonly schema: string;
    readonly name: string;
    readonly columns: readonly {
      readonly name: string;
      readonly dataType: string;
      readonly nullable: boolean;
    }[];
  }[];
}> {
  const rows = z.array(SchemaRowSchema).parse(
    await sql.query(`select table_schema, table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name, ordinal_position`),
  );
  const tables = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    tables.set(key, [...(tables.get(key) ?? []), row]);
  }
  return {
    dialect: 'postgresql',
    tables: [...tables.values()].map((columns) => ({
      schema: columns[0]?.table_schema ?? '',
      name: columns[0]?.table_name ?? '',
      columns: columns.map((column) => ({
        name: column.column_name,
        dataType: column.data_type,
        nullable: column.is_nullable === 'YES',
      })),
    })),
  };
}

export interface NeonValidationBranchPort {
  createValidationBranch(input: z.input<typeof ValidationBranchInputSchema>): Promise<{
    readonly branchId: string;
    readonly migrationConnectionString: string;
  }>;
  deleteBranch(input: z.input<typeof DeleteBranchInputSchema>): Promise<void>;
}

export function createNeonValidationBranchPort(
  management: NeonManagementPort,
): NeonValidationBranchPort {
  return {
    async createValidationBranch(rawInput) {
      const input = ValidationBranchInputSchema.parse(rawInput);
      const branchInput = CreateBranchInputSchema.parse({
        projectId: input.projectId,
        apiKey: input.apiKey,
        parentBranchId: input.parentBranchId,
        name: input.name,
        expiresAt: input.expiresAt,
      });
      const project = { projectId: input.projectId, apiKey: input.apiKey };
      const prior = (await management.listBranches(project)).find(
        (branch) => branch.name === input.name,
      );
      if (prior !== undefined) {
        if (prior.parentBranchId !== input.parentBranchId) {
          throw new Error('neon_validation_branch_parent_mismatch');
        }
        await management.deleteBranch({
          projectId: input.projectId,
          apiKey: input.apiKey,
          branchId: prior.id,
        });
      }

      let branch: NeonBranch;
      try {
        branch = await management.createBranch(branchInput);
      } catch (createError) {
        const reconciled = (await management.listBranches(project)).find(
          (candidate) => candidate.name === input.name,
        );
        if (reconciled === undefined || reconciled.parentBranchId !== input.parentBranchId) {
          throw createError;
        }
        branch = reconciled;
      }
      try {
        const connection = await management.branchConnection({
          projectId: input.projectId,
          apiKey: input.apiKey,
          branchId: branch.id,
          databaseName: input.databaseName,
        });
        return { branchId: branch.id, migrationConnectionString: connection.uri };
      } catch (connectionError) {
        try {
          await management.deleteBranch({
            projectId: input.projectId,
            apiKey: input.apiKey,
            branchId: branch.id,
          });
        } catch (cleanupError) {
          throw new AggregateError(
            [connectionError, cleanupError],
            'neon_validation_branch_connection_and_cleanup_failed',
          );
        }
        throw connectionError;
      }
    },
    deleteBranch: (input) => management.deleteBranch(input),
  };
}

export async function ensureNeonPreviewBranch(input: {
  readonly management: NeonManagementPort;
  readonly projectId: string;
  readonly apiKey: string;
  readonly name: string;
  readonly parentBranchId: string;
}): Promise<NeonBranch> {
  const parsed = CreateBranchInputSchema.omit({ expiresAt: true }).parse({
    projectId: input.projectId,
    apiKey: input.apiKey,
    name: input.name,
    parentBranchId: input.parentBranchId,
  });
  const branches = await input.management.listBranches({
    projectId: parsed.projectId,
    apiKey: parsed.apiKey,
  });
  const existing = branches.find((branch) => branch.name === parsed.name);
  if (existing !== undefined) {
    if (existing.parentBranchId !== parsed.parentBranchId) {
      throw new Error('neon_preview_branch_parent_mismatch');
    }
    return existing;
  }
  return await input.management.createBranch(parsed);
}
