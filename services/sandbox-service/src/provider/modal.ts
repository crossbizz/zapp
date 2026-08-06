import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { posix } from 'node:path';
import { ModalClient } from 'modal';
import { z } from 'zod';
import {
  AgentHealthSchema,
  ImageSmokeEvidenceSchema,
  ModalCredentialsSchema,
  PublishImageInputSchema,
  PublishedImageSchema,
  SmokeImageInputSchema,
  type ImageRecipe,
  type ModalCredentials,
  type ModalImagePublisher,
} from './types.js';

const ModalSdkRunResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();
export type ModalSdkRunResult = z.infer<typeof ModalSdkRunResultSchema>;

const AgentExecResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().finite().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

const HEALTH_PROBE_TIMEOUT_MS = 30_000;
const HEALTH_PROBE_INTERVAL_MS = 250;

export interface ModalSdkBuildInput {
  readonly environment: 'zapp-dev' | 'zapp-staging' | 'zapp-prod';
  readonly appName: 'zapp-workspaces' | 'zapp-browser-verify';
  readonly publishedName: string;
  readonly recipe: ImageRecipe;
}

export interface ModalSdkVmSandboxInput {
  readonly environment: 'zapp-dev' | 'zapp-staging' | 'zapp-prod';
  readonly appName: 'zapp-workspaces';
  readonly digest: string;
  readonly publishedName: string;
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly experimentalOptions: Readonly<{ vm_runtime: true }>;
}

export interface ModalSdkSandboxPort {
  exec(command: string[]): Promise<ModalSdkRunResult>;
  terminate(): Promise<void>;
}

export interface ModalSdkPort {
  buildAndPublish(input: ModalSdkBuildInput): Promise<string>;
  createVmSandbox(input: ModalSdkVmSandboxInput): Promise<ModalSdkSandboxPort>;
  close(): void;
}

interface ModalImagePublisherOptions {
  readonly credentials?: ModalCredentials;
  readonly sdkFactory?: () => ModalSdkPort;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function fileCommands(recipe: ImageRecipe): string[] {
  return recipe.files.map((file) => {
    const encoded = Buffer.from(file.contents, 'utf8').toString('base64');
    return `RUN install -d -m 0755 ${shellQuote(posix.dirname(file.path))} && printf %s ${shellQuote(encoded)} | base64 --decode > ${shellQuote(file.path)} && chmod ${file.mode} ${shellQuote(file.path)}`;
  });
}

function credentialsFromEnvironment(): ModalCredentials {
  return ModalCredentialsSchema.parse({
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
  });
}

function createSdkPort(credentials: ModalCredentials): ModalSdkPort {
  const parsedCredentials = ModalCredentialsSchema.parse(credentials);
  const client = new ModalClient({
    tokenId: parsedCredentials.tokenId,
    tokenSecret: parsedCredentials.tokenSecret,
  });

  return {
    async buildAndPublish(input) {
      const app = await client.apps.fromName(input.appName, {
        environment: input.environment,
        createIfMissing: true,
      });
      const base =
        input.recipe.base.kind === 'registry'
          ? client.images.fromRegistry(input.recipe.base.ref)
          : await client.images.fromId(input.recipe.base.digest);
      const image = base.dockerfileCommands([
        ...input.recipe.commands,
        ...fileCommands(input.recipe),
      ]);
      const built = await image.build(app);
      await built.publish(input.publishedName, { environment: input.environment });
      return built.imageId;
    },

    async createVmSandbox(input) {
      const app = await client.apps.fromName(input.appName, {
        environment: input.environment,
        createIfMissing: true,
      });
      // Resolve the named publication instead of bypassing the tag through its ID:
      // the smoke is evidence that the exact lock-file tag is usable.
      const image = await client.images.fromName(input.publishedName, {
        environment: input.environment,
      });
      const sandbox = await client.sandboxes.experimentalCreate(app, image, {
        command: ['/usr/bin/dumb-init', '--', '/opt/zapp/boot.sh'],
        env: { ...input.environmentVariables },
        encryptedPorts: [8877],
        timeoutMs: 120_000,
        experimentalOptions: { ...input.experimentalOptions },
      });

      return {
        async exec(command) {
          const remoteProcess = await sandbox.exec(command, {
            mode: 'text',
            timeoutMs: 60_000,
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            remoteProcess.stdout.readText(),
            remoteProcess.stderr.readText(),
            remoteProcess.wait(),
          ]);
          return ModalSdkRunResultSchema.parse({ exitCode, stdout, stderr });
        },
        async terminate() {
          await sandbox.terminate();
        },
      };
    },

    close() {
      client.close();
    },
  };
}

async function execOrThrow(
  sandbox: ModalSdkSandboxPort,
  command: string[],
  purpose: string,
): Promise<ModalSdkRunResult> {
  const result = ModalSdkRunResultSchema.parse(await sandbox.exec(command));
  if (result.exitCode !== 0) {
    throw new Error(`${purpose} failed with exit code ${String(result.exitCode)}`);
  }
  return result;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function authenticatedCurl(
  token: string,
  path: string,
  body?: Readonly<Record<string, unknown>>,
): string[] {
  const command = [
    'curl',
    '--fail-with-body',
    '--silent',
    '--show-error',
    '--header',
    `Authorization: Bearer ${token}`,
  ];
  if (body !== undefined) {
    command.push(
      '--request',
      'POST',
      '--header',
      'Content-Type: application/json',
      '--header',
      `Idempotency-Key: ${randomUUID()}`,
      '--data',
      JSON.stringify(body),
    );
  }
  command.push(`http://127.0.0.1:8877${path}`);
  return command;
}

async function waitForAgentHealth(
  sandbox: ModalSdkSandboxPort,
  token: string,
): Promise<z.infer<typeof AgentHealthSchema>> {
  const deadline = Date.now() + HEALTH_PROBE_TIMEOUT_MS;
  let lastFailure = 'workspace-agent did not answer';
  do {
    const response = ModalSdkRunResultSchema.parse(
      await sandbox.exec(authenticatedCurl(token, '/healthz')),
    );
    if (response.exitCode === 0) {
      const health = AgentHealthSchema.safeParse(JSON.parse(response.stdout) as unknown);
      if (health.success) {
        return health.data;
      }
      lastFailure = 'workspace-agent returned an invalid health response';
    } else {
      lastFailure = `workspace-agent health probe exited ${String(response.exitCode)}`;
    }
    await delay(HEALTH_PROBE_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error(`${lastFailure} before the 30 second readiness deadline`);
}

async function runSmoke(
  sdk: ModalSdkPort,
  untrustedInput: Parameters<ModalImagePublisher['smokeImage']>[0],
) {
  const input = SmokeImageInputSchema.parse(untrustedInput);
  const environmentVariables: Record<string, string> = {
    ZAPP_AGENT_TOKEN: input.agentToken,
    ZAPP_WORKSPACE_ROOT: '/workspace',
  };
  if (input.telemetryEndpoint !== undefined) {
    environmentVariables.ZAPP_TELEMETRY_ENDPOINT = input.telemetryEndpoint;
  }

  const sandbox = await sdk.createVmSandbox({
    environment: input.environment,
    appName: input.appName,
    digest: input.digest,
    publishedName: input.publishedName,
    environmentVariables,
    experimentalOptions: { vm_runtime: true },
  });

  try {
    const node = await execOrThrow(sandbox, ['node', '--version'], 'Node version probe');
    const nodeVersion = node.stdout.trim();
    if (!/^v22\./u.test(nodeVersion)) {
      throw new Error(`Expected Node.js 22, received ${nodeVersion}`);
    }

    const health = await waitForAgentHealth(sandbox, input.agentToken);

    await execOrThrow(
      sandbox,
      ['sh', '-lc', 'rm -f /tmp/zapp-cgroup-escape'],
      'cgroup marker reset',
    );
    const detachedProbeResponse = await execOrThrow(
      sandbox,
      authenticatedCurl(input.agentToken, '/exec', {
        cmd: 'sh',
        args: [
          '-lc',
          "setsid sh -c 'sleep 1; echo escaped > /tmp/zapp-cgroup-escape' >/dev/null 2>&1 & sleep 30",
        ],
        timeoutMs: 250,
      }),
      'detached-child cgroup probe',
    );
    const detachedProbe = AgentExecResultSchema.parse(
      JSON.parse(detachedProbeResponse.stdout) as unknown,
    );
    if (detachedProbe.exitCode === 0) {
      throw new Error('Detached-child cgroup probe did not time out');
    }

    await execOrThrow(
      sandbox,
      ['sh', '-lc', 'sleep 2; test ! -e /tmp/zapp-cgroup-escape'],
      'cgroup.kill descendant probe',
    );

    const emptySignalResponse = await execOrThrow(
      sandbox,
      authenticatedCurl(input.agentToken, '/exec', {
        cmd: 'true',
        args: [],
        timeoutMs: 5_000,
      }),
      'cgroup empty-state probe',
    );
    const emptySignal = AgentExecResultSchema.parse(
      JSON.parse(emptySignalResponse.stdout) as unknown,
    );
    if (emptySignal.exitCode !== 0) {
      throw new Error('cgroup.events empty-state probe failed');
    }

    return ImageSmokeEvidenceSchema.parse({
      nodeVersion,
      health,
      vmRuntime: true,
      cgroup: { delegated: true, kill: true, emptySignal: true },
      terminated: true,
    });
  } finally {
    await sandbox.terminate();
  }
}

export function createModalImagePublisher(
  options: ModalImagePublisherOptions = {},
): ModalImagePublisher {
  const sdkFactory =
    options.sdkFactory ??
    (() => createSdkPort(options.credentials ?? credentialsFromEnvironment()));

  return {
    async publishImage(untrustedInput) {
      const input = PublishImageInputSchema.parse(untrustedInput);
      const sdk = sdkFactory();
      try {
        const digest = await sdk.buildAndPublish({
          environment: input.environment,
          appName: input.appName,
          publishedName: input.publishedName,
          recipe: input.recipe,
        });
        return PublishedImageSchema.parse({ digest, publishedName: input.publishedName });
      } finally {
        sdk.close();
      }
    },

    async smokeImage(untrustedInput) {
      const sdk = sdkFactory();
      try {
        return await runSmoke(sdk, untrustedInput);
      } finally {
        sdk.close();
      }
    },
  };
}
