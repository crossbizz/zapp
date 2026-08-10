import { createServiceTokenSigner, type ServiceTokenConfig } from '@zapp/config';
import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

const EnvironmentNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/u);
const SecretIdListSchema = z.array(idSchema('sec')).max(200);

const DecryptRequestSchema = z
  .object({
    organizationId: idSchema('org'),
    secretId: idSchema('sec'),
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

const DecryptResponseSchema = z
  .object({
    secret: z
      .object({
        id: idSchema('sec'),
        organizationId: idSchema('org'),
        projectId: idSchema('proj').nullable(),
        environmentId: idSchema('env').nullable(),
        name: EnvironmentNameSchema,
        keyVersion: z.number().int().positive(),
      })
      .strict(),
    value: z.string(),
  })
  .strict();

const ResolveSecretsInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    secretIds: SecretIdListSchema,
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

const FORBIDDEN_EXACT = new Set(['DATABASE_URL']);
const FORBIDDEN_PREFIXES = [
  'MODAL_',
  'SERVICE_TOKEN_',
  'STYTCH_',
  'GRAFANA_',
  'FLEXPRICE_',
] as const;
const PLATFORM_ENV_NAMES = new Set([
  'NPM_CONFIG_STORE_DIR',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PNPM_STORE_DIR',
  'ZAPP_AGENT_TOKEN',
  'ZAPP_SECRET_NAMES',
]);

export type SecretRegistry = Readonly<Record<string, string>>;

export interface SecretDecryptPort {
  decrypt(input: z.infer<typeof DecryptRequestSchema>): Promise<unknown>;
}

export interface ControlPlaneSecretDecryptClientOptions {
  readonly baseUrl: string;
  readonly serviceTokens: ServiceTokenConfig;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

export function createControlPlaneSecretDecryptClient(
  options: ControlPlaneSecretDecryptClientOptions,
): SecretDecryptPort {
  const baseUrl = z
    .string()
    .url()
    .refine((value) => /^https?:\/\//u.test(value), 'Control API URL must use HTTP or HTTPS')
    .parse(options.baseUrl);
  const endpoint = new URL('/internal/secrets/decrypt', baseUrl).toString();
  const signer = createServiceTokenSigner(options.serviceTokens);
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    async decrypt(untrustedInput) {
      const input = DecryptRequestSchema.parse(untrustedInput);
      const { token } = await signer.signServiceToken({
        service: 'sandbox-service',
        aud: 'control-api:secrets.decrypt',
      });
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'cache-control': 'no-store',
            'content-type': 'application/json',
            'x-zapp-service-token': token,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        throw new Error('The secret decrypt service could not be reached.', { cause: error });
      }
      if (response.status !== 200) {
        throw new Error(`The secret decrypt service refused the request (${String(response.status)}).`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error('The secret decrypt service returned invalid JSON.', { cause: error });
      }
      return DecryptResponseSchema.parse(body);
    },
  };
}

export interface ResolvedWorkspaceSecrets {
  readonly values: SecretRegistry;
  /** Safe to expose to the workspace-agent process: names only, never values. */
  readonly agentEnvironment: Readonly<{ ZAPP_SECRET_NAMES: string }>;
}

function assertInjectableName(name: string): void {
  const parsed = EnvironmentNameSchema.parse(name);
  if (
    FORBIDDEN_EXACT.has(parsed) ||
    FORBIDDEN_PREFIXES.some((prefix) => parsed.startsWith(prefix))
  ) {
    throw new Error(`Secret name ${parsed} is reserved for the platform.`);
  }
  if (PLATFORM_ENV_NAMES.has(parsed)) {
    throw new Error(`Secret name ${parsed} is reserved for the sandbox runtime.`);
  }
}

export function createScopedSecretInjector(port: SecretDecryptPort) {
  return {
    async resolve(input: z.infer<typeof ResolveSecretsInputSchema>): Promise<ResolvedWorkspaceSecrets> {
      const scope = ResolveSecretsInputSchema.parse(input);
      const resolved = new Map<string, { readonly value: string; readonly environmentSpecific: boolean }>();
      for (const secretId of scope.secretIds) {
        const decrypted = DecryptResponseSchema.parse(
          await port.decrypt(
            DecryptRequestSchema.parse({
              organizationId: scope.organizationId,
              secretId,
              reason: scope.reason,
            }),
          ),
        );
        if (
          decrypted.secret.id !== secretId ||
          decrypted.secret.organizationId !== scope.organizationId ||
          decrypted.secret.projectId !== scope.projectId ||
          (decrypted.secret.environmentId !== null &&
            decrypted.secret.environmentId !== scope.environmentId)
        ) {
          throw new Error('Decrypted secret metadata did not match the requested scope.');
        }
        assertInjectableName(decrypted.secret.name);
        const environmentSpecific = decrypted.secret.environmentId === scope.environmentId;
        const existing = resolved.get(decrypted.secret.name);
        if (existing !== undefined && existing.environmentSpecific === environmentSpecific) {
          throw new Error(`Secret name ${decrypted.secret.name} was returned more than once in one scope.`);
        }
        if (existing === undefined || environmentSpecific) {
          resolved.set(decrypted.secret.name, { value: decrypted.value, environmentSpecific });
        }
      }
      const names = [...resolved.keys()].sort();
      return {
        values: Object.fromEntries(names.map((name) => [name, resolved.get(name)?.value ?? ''])),
        agentEnvironment: { ZAPP_SECRET_NAMES: JSON.stringify(names) },
      };
    },
  };
}

export function assertSandboxEnvironment(
  environment: Readonly<Record<string, string>>,
  contractDeclaredNames: readonly string[] = [],
): void {
  const allowed = new Set([...PLATFORM_ENV_NAMES, ...contractDeclaredNames.map((name) => EnvironmentNameSchema.parse(name))]);
  for (const name of Object.keys(environment)) {
    const parsed = EnvironmentNameSchema.parse(name);
    if (
      FORBIDDEN_EXACT.has(parsed) ||
      FORBIDDEN_PREFIXES.some((prefix) => parsed.startsWith(prefix))
    ) {
      throw new Error(`Sandbox environment contains forbidden key ${parsed}.`);
    }
    if (!allowed.has(parsed)) {
      throw new Error(`Sandbox environment key ${parsed} was not declared.`);
    }
  }
}

export function redactSecretText(text: string, registry: SecretRegistry): string {
  const entries = Object.entries(registry)
    .filter(([, value]) => value.length > 0)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
  let redacted = text;
  for (const [name, value] of entries) {
    redacted = redacted.split(value).join(`[secret:${name}]`);
  }
  return redacted;
}

export function redactExecResult<
  T extends {
    readonly stdout: string;
    readonly stderr: string;
  },
>(result: T, registry: SecretRegistry): T {
  return {
    ...result,
    stdout: redactSecretText(result.stdout, registry),
    stderr: redactSecretText(result.stderr, registry),
  };
}

export function createSecretStreamRedactor(registry: SecretRegistry) {
  const entries = Object.entries(registry)
    .filter(([, value]) => value.length > 0)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
  let pending = '';

  const consume = (final: boolean): string => {
    let output = '';
    for (;;) {
      if (pending === '') return output;
      let match: { readonly index: number; readonly name: string; readonly value: string } | undefined;
      for (const [name, value] of entries) {
        const index = pending.indexOf(value);
        if (
          index >= 0 &&
          (match === undefined ||
            index < match.index ||
            (index === match.index && value.length > match.value.length))
        ) {
          match = { index, name, value };
        }
      }
      if (match !== undefined) {
        output += pending.slice(0, match.index) + `[secret:${match.name}]`;
        pending = pending.slice(match.index + match.value.length);
        continue;
      }
      if (final) {
        output += pending;
        pending = '';
        return output;
      }
      let retained = 0;
      for (const [, value] of entries) {
        const upper = Math.min(value.length - 1, pending.length);
        for (let length = upper; length > retained; length -= 1) {
          if (value.startsWith(pending.slice(-length))) {
            retained = length;
            break;
          }
        }
      }
      const safeLength = pending.length - retained;
      if (safeLength === 0) return output;
      output += pending.slice(0, safeLength);
      pending = pending.slice(safeLength);
      return output;
    }
  };

  return {
    push(chunk: string): string {
      pending += chunk;
      return consume(false);
    },
    finish(): string {
      return consume(true);
    },
  };
}

export type ScopedSecretInjector = ReturnType<typeof createScopedSecretInjector>;
