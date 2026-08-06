import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { posix } from 'node:path';
import { ModalClient, NotFoundError, Probe } from 'modal';
import { z } from 'zod';
import {
  AgentHealthSchema,
  ImageDigestSchema,
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
const CleanupResponseSchema = z.object({ cleaned: z.literal(true) }).strict();

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
  readonly encryptedPorts: readonly [8877];
  readonly readinessProbe: Readonly<{ kind: 'tcp'; port: 8877; intervalMs: 250 }>;
  readonly volumeMountPath: '/workspace-probe';
}

export interface ModalSdkTunnel {
  readonly url: string;
}

export interface ModalSdkSandboxPort {
  exec(command: string[]): Promise<ModalSdkRunResult>;
  waitUntilReady(timeoutMs: number): Promise<void>;
  tunnels(timeoutMs: number): Promise<Readonly<Record<number, ModalSdkTunnel>>>;
  snapshotFilesystem(input: {
    readonly timeoutMs: number;
    readonly ttlMs: number;
  }): Promise<string>;
  terminate(): Promise<void>;
}

export interface ModalSdkPort {
  buildImage(input: ModalSdkBuildInput): Promise<string>;
  resolvePublishedImage(input: {
    readonly environment: ModalSdkBuildInput['environment'];
    readonly publishedName: string;
  }): Promise<string | undefined>;
  publishImageId(input: {
    readonly environment: ModalSdkBuildInput['environment'];
    readonly publishedName: string;
    readonly digest: string;
  }): Promise<void>;
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

export function imageDockerfileCommands(recipe: ImageRecipe): string[] {
  return [...fileCommands(recipe), ...recipe.commands];
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
    async buildImage(input) {
      const app = await client.apps.fromName(input.appName, {
        environment: input.environment,
        createIfMissing: true,
      });
      const base =
        input.recipe.base.kind === 'registry'
          ? client.images.fromRegistry(input.recipe.base.ref)
          : await client.images.fromId(input.recipe.base.digest);
      const image = base.dockerfileCommands(imageDockerfileCommands(input.recipe));
      const built = await image.build(app);
      return built.imageId;
    },

    async resolvePublishedImage(input) {
      try {
        return (
          await client.images.fromName(input.publishedName, { environment: input.environment })
        ).imageId;
      } catch (error) {
        if (error instanceof NotFoundError) {
          return undefined;
        }
        throw error;
      }
    },

    async publishImageId(input) {
      const image = await client.images.fromId(input.digest);
      await image.publish(input.publishedName, { environment: input.environment });
    },

    async createVmSandbox(input) {
      const app = await client.apps.fromName(input.appName, {
        environment: input.environment,
        createIfMissing: true,
      });
      // runSmoke resolves and verifies the immutable name immediately before
      // this call. Create from the verified digest so a tag repoint cannot
      // switch the image between verification and sandbox creation.
      const image = await client.images.fromId(input.digest);
      const volume = await client.volumes.ephemeral({ environment: input.environment });
      let sandbox: Awaited<ReturnType<typeof client.sandboxes.experimentalCreate>>;
      try {
        sandbox = await client.sandboxes.experimentalCreate(app, image, {
          command: ['/usr/bin/dumb-init', '--', '/opt/zapp/boot.sh'],
          env: { ...input.environmentVariables },
          volumes: { [input.volumeMountPath]: volume },
          encryptedPorts: [...input.encryptedPorts],
          readinessProbe: Probe.withTcp(input.readinessProbe.port, {
            intervalMs: input.readinessProbe.intervalMs,
          }),
          timeoutMs: 120_000,
          experimentalOptions: { ...input.experimentalOptions },
        });
      } catch (error) {
        volume.closeEphemeral();
        throw error;
      }

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
        async waitUntilReady(timeoutMs) {
          await sandbox.waitUntilReady(timeoutMs);
        },
        async tunnels(timeoutMs) {
          const tunnels = await sandbox.tunnels(timeoutMs);
          return Object.fromEntries(
            Object.entries(tunnels).map(([port, tunnel]) => [port, { url: tunnel.url }]),
          );
        },
        async snapshotFilesystem(snapshotInput) {
          const snapshot = await sandbox.snapshotFilesystem(snapshotInput);
          return snapshot.imageId;
        },
        async terminate() {
          try {
            await sandbox.terminate();
          } finally {
            volume.closeEphemeral();
          }
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

function authenticatedAgentUrl(path: string, cleanupId?: string): string {
  const url = new URL(`http://127.0.0.1:8877${path}`);
  if (cleanupId !== undefined) {
    url.searchParams.set('cleanupId', cleanupId);
  }
  return url.href;
}

function authenticatedCurlTo(
  token: string,
  url: string,
  body?: Readonly<Record<string, unknown>>,
): string[] {
  const command = authenticatedCurl(token, '', body);
  command[command.length - 1] = url;
  return command;
}

async function acknowledgeCleanup(
  sandbox: ModalSdkSandboxPort,
  token: string,
  cleanupId: string,
): Promise<void> {
  const response = await execOrThrow(
    sandbox,
    authenticatedCurlTo(token, authenticatedAgentUrl(`/exec/cleanup/${cleanupId}`)),
    'containment cleanup acknowledgement',
  ).catch(() => {
    throw new Error('containment cleanup acknowledgement failed');
  });
  CleanupResponseSchema.parse(JSON.parse(response.stdout) as unknown);
}

function detachedChildCommand(marker: string): string {
  return `setsid sh -c 'sleep 1; echo escaped > ${marker}' >/dev/null 2>&1 & sleep 30`;
}

async function probeTimeoutCleanup(
  sandbox: ModalSdkSandboxPort,
  token: string,
  label: 'buffered-timeout' | 'pty-timeout',
  pty: boolean,
): Promise<void> {
  const cleanupId = randomUUID();
  const marker = `/tmp/zapp-${label}-escaped`;
  await execOrThrow(sandbox, ['sh', '-lc', `rm -f ${marker}`], `${label} marker reset`);
  const response = await execOrThrow(
    sandbox,
    authenticatedCurlTo(token, authenticatedAgentUrl('/exec', cleanupId), {
      cmd: 'sh',
      args: ['-lc', detachedChildCommand(marker)],
      timeoutMs: 250,
      pty,
    }),
    `${label} detached-child probe`,
  );
  const result = AgentExecResultSchema.parse(JSON.parse(response.stdout) as unknown);
  if (result.exitCode === 0) {
    throw new Error(`${label} did not time out`);
  }
  await acknowledgeCleanup(sandbox, token, cleanupId);
  await execOrThrow(
    sandbox,
    ['sh', '-lc', `sleep 2; test ! -e ${marker}`],
    `${label} cgroup.kill probe`,
  );
}

function agentRequestScript(
  token: string,
  cleanupId: string,
  label: 'disconnect' | 'explicit-kill' | 'pid-ownership',
  pty: boolean,
): string {
  const scenario = `${label}-${pty ? 'pty' : 'buffered'}`;
  const output = `/tmp/zapp-${scenario}.ndjson`;
  const executionUrl = authenticatedAgentUrl('/exec?stream=1', cleanupId);
  const commonHeaders = `--header ${shellQuote(`Authorization: Bearer ${token}`)} --header 'Content-Type: application/json'`;
  const execHeaders = `${commonHeaders} --header ${shellQuote(`Idempotency-Key: ${randomUUID()}`)}`;
  const killHeaders = `${commonHeaders} --header ${shellQuote(`Idempotency-Key: ${randomUUID()}`)}`;
  const detachedBody = JSON.stringify({
    cmd: 'sh',
    args: ['-lc', detachedChildCommand(`/tmp/zapp-${scenario}-escaped`)],
    timeoutMs: 30_000,
    pty,
  });
  if (label === 'disconnect') {
    return `set -euo pipefail; rm -f ${output}; set +e; curl --max-time 0.25 --silent --show-error ${execHeaders} --request POST --data ${shellQuote(detachedBody)} ${shellQuote(executionUrl)} > ${output}; status=$?; set -e; test "$status" -ne 0`;
  }

  const body =
    label === 'pid-ownership'
      ? JSON.stringify({ cmd: 'true', args: [], timeoutMs: 5_000, pty })
      : detachedBody;
  const expectedKilled = label === 'explicit-kill' ? 'true' : 'false';
  const expectedExit =
    label === 'explicit-kill' ? `test "$exit_code" -ne 0` : `test "$exit_code" -eq 0`;
  return `set -euo pipefail; rm -f ${output}; curl --silent --show-error ${execHeaders} --request POST --data ${shellQuote(body)} ${shellQuote(executionUrl)} > ${output} & request_pid=$!; for _ in $(seq 1 200); do grep -q '"type":"started"' ${output} && break; sleep 0.025; done; pid=$(jq -r 'select(.type == "started") | .pid' ${output} | head -n1); test -n "$pid"; if [ ${shellQuote(label)} = 'explicit-kill' ]; then kill_result=$(curl --fail-with-body --silent --show-error ${killHeaders} --request POST "http://127.0.0.1:8877/exec/$pid/kill"); wait "$request_pid"; else wait "$request_pid"; kill_result=$(curl --fail-with-body --silent --show-error ${killHeaders} --request POST "http://127.0.0.1:8877/exec/$pid/kill"); fi; test "$(printf %s "$kill_result" | jq -r .killed)" = ${shellQuote(expectedKilled)}; exit_code=$(jq -r 'select(.type == "exit") | .exitCode' ${output} | tail -n1); ${expectedExit}`;
}

async function probeScriptedLifecycle(
  sandbox: ModalSdkSandboxPort,
  token: string,
  label: 'disconnect' | 'explicit-kill' | 'pid-ownership',
  pty: boolean,
): Promise<void> {
  const cleanupId = randomUUID();
  const scenario = `${label}-${pty ? 'pty' : 'buffered'}`;
  await execOrThrow(
    sandbox,
    ['sh', '-lc', agentRequestScript(token, cleanupId, label, pty)],
    `${scenario} cleanup probe`,
  );
  await acknowledgeCleanup(sandbox, token, cleanupId);
  if (label !== 'pid-ownership') {
    await execOrThrow(
      sandbox,
      ['sh', '-lc', `sleep 2; test ! -e /tmp/zapp-${scenario}-escaped`],
      `${scenario} detached-child probe`,
    );
  }
}

function shutdownProbeScript(token: string, pty: boolean): string {
  const scenario = `agent-shutdown-${pty ? 'pty' : 'buffered'}`;
  const ready = `/tmp/zapp-${scenario}-ready`;
  const cleaned = `/tmp/zapp-${scenario}-cleaned`;
  const escaped = `/tmp/zapp-${scenario}-escaped`;
  const cleanupId = randomUUID();
  const childProgram = [
    "import { writeFileSync } from 'node:fs';",
    "import { buildWorkspaceAgent, closeWorkspaceAgentForSignal } from '/opt/zapp/agent/dist/main.js';",
    `const app = await buildWorkspaceAgent({ workspaceRoot: '/workspace', token: ${JSON.stringify(token)} });`,
    "await app.listen({ host: '127.0.0.1', port: 8878 });",
    `writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    "process.once('SIGTERM', () => { void closeWorkspaceAgentForSignal(app, (code) => {",
    `  if (code === 0) writeFileSync(${JSON.stringify(cleaned)}, 'cleaned');`,
    '  process.exit(code);',
    '}, () => undefined); });',
    'await new Promise(() => undefined);',
  ].join('\n');
  const headers = `--header ${shellQuote(`Authorization: Bearer ${token}`)} --header 'Content-Type: application/json' --header ${shellQuote(`Idempotency-Key: ${randomUUID()}`)}`;
  const body = JSON.stringify({
    cmd: 'sh',
    args: ['-lc', detachedChildCommand(escaped)],
    timeoutMs: 30_000,
    pty,
  });
  const url = `http://127.0.0.1:8878/exec?stream=1&cleanupId=${cleanupId}`;
  const output = `/tmp/zapp-${scenario}.ndjson`;
  return `set -euo pipefail; rm -f ${ready} ${cleaned} ${escaped} ${output}; node --input-type=module -e ${shellQuote(childProgram)} & agent_pid=$!; for _ in $(seq 1 200); do test -e ${ready} && break; sleep 0.025; done; test -e ${ready}; curl --silent --show-error ${headers} --request POST --data ${shellQuote(body)} ${shellQuote(url)} >${output} & request_pid=$!; for _ in $(seq 1 200); do grep -q '"type":"started"' ${output} && break; sleep 0.025; done; kill -TERM "$agent_pid"; wait "$agent_pid"; wait "$request_pid" || true; test -e ${cleaned}; sleep 2; test ! -e ${escaped}`;
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
  const resolvedDigest = await sdk.resolvePublishedImage({
    environment: input.environment,
    publishedName: input.publishedName,
  });
  if (resolvedDigest !== input.digest) {
    throw new Error('Locked image digest does not match the published name');
  }
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
    encryptedPorts: [8877],
    readinessProbe: { kind: 'tcp', port: 8877, intervalMs: 250 },
    volumeMountPath: '/workspace-probe',
  });

  try {
    await sandbox.waitUntilReady(HEALTH_PROBE_TIMEOUT_MS);
    const node = await execOrThrow(sandbox, ['node', '--version'], 'Node version probe');
    const nodeVersion = node.stdout.trim();
    if (!/^v22\./u.test(nodeVersion)) {
      throw new Error(`Expected Node.js 22, received ${nodeVersion}`);
    }

    const health = await waitForAgentHealth(sandbox, input.agentToken);

    await probeTimeoutCleanup(sandbox, input.agentToken, 'buffered-timeout', false);
    await probeTimeoutCleanup(sandbox, input.agentToken, 'pty-timeout', true);
    for (const pty of [false, true]) {
      await probeScriptedLifecycle(sandbox, input.agentToken, 'disconnect', pty);
      await probeScriptedLifecycle(sandbox, input.agentToken, 'explicit-kill', pty);
      await execOrThrow(
        sandbox,
        ['sh', '-lc', shutdownProbeScript(input.agentToken, pty)],
        `agent-shutdown-${pty ? 'pty' : 'buffered'} cleanup probe`,
      );
    }
    await probeScriptedLifecycle(sandbox, input.agentToken, 'pid-ownership', false);

    const volumeNonce = randomUUID();
    await execOrThrow(
      sandbox,
      [
        'sh',
        '-lc',
        `printf %s ${shellQuote(volumeNonce)} > /workspace-probe/ws-2 && test "$(cat /workspace-probe/ws-2)" = ${shellQuote(volumeNonce)}`,
      ],
      'V2 volume read/write probe',
    );
    const snapshotDigest = ImageDigestSchema.parse(
      await sandbox.snapshotFilesystem({ timeoutMs: 55_000, ttlMs: 86_400_000 }),
    );
    const tunnel = (await sandbox.tunnels(30_000))[8877];
    if (tunnel === undefined || new URL(tunnel.url).protocol !== 'https:') {
      throw new Error('V2 encrypted tunnel probe failed');
    }

    return ImageSmokeEvidenceSchema.parse({
      nodeVersion,
      health,
      vmRuntime: true,
      cgroup: { delegated: true, kill: true, emptySignal: true },
      lifecycle: {
        timeout: { buffered: true, pty: true },
        disconnect: { buffered: true, pty: true },
        explicitKill: { buffered: true, pty: true },
        agentShutdown: { buffered: true, pty: true },
        pidOwnership: true,
      },
      capabilities: {
        volumeReadWrite: true,
        filesystemSnapshot: snapshotDigest,
        encryptedTunnel: true,
        readinessProbe: true,
      },
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
        const digest = ImageDigestSchema.parse(
          await sdk.buildImage({
            environment: input.environment,
            appName: input.appName,
            publishedName: input.publishedName,
            recipe: input.recipe,
          }),
        );
        const existing = await sdk.resolvePublishedImage({
          environment: input.environment,
          publishedName: input.publishedName,
        });
        if (existing !== undefined && existing !== digest) {
          throw new Error('Immutable image name resolves to a different image ID');
        }
        if (existing === undefined) {
          await sdk.publishImageId({
            environment: input.environment,
            publishedName: input.publishedName,
            digest,
          });
          const published = await sdk.resolvePublishedImage({
            environment: input.environment,
            publishedName: input.publishedName,
          });
          if (published !== digest) {
            throw new Error('Immutable image name resolves to a different image ID');
          }
        }
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
