import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';

import { z } from 'zod';

import {
  ModalSandboxProvider,
  ModalWorkspaceNotFoundError,
  type AgentHttpRequest,
  type AgentHttpResponse,
  type AgentHttpStream,
  type ModalSandboxProviderOptions,
  type ModalSdkTunnel,
  type ModalWorkspaceCreateOptions,
  type ModalWorkspaceSandbox,
  type ModalWorkspaceSdkPort,
} from './modal.js';
import { ImageBaseSchema, ImageDigestSchema, SandboxTagsSchema } from './types.js';
import { BranchLockedError } from './volumes.js';

const DockerCommandResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();
export type DockerCommandResult = z.infer<typeof DockerCommandResultSchema>;

export interface DockerCommandPort {
  run(args: readonly string[], timeoutMs?: number): Promise<DockerCommandResult>;
}

const DockerImageLockSchema = z
  .object({
    publicMirrors: z
      .object({
        'forge-node-base': z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

const DockerInspectSchema = z
  .array(
    z
      .object({
        Id: z.string().regex(/^[a-f0-9]{12,64}$/u),
        State: z.object({ Running: z.boolean() }).passthrough(),
        Config: z.object({ Labels: z.record(z.string()).nullish() }).passthrough(),
        NetworkSettings: z
          .object({
            Networks: z.record(z.unknown()),
            Ports: z.record(
              z
                .array(
                  z
                    .object({
                      HostIp: z.string(),
                      HostPort: z.string().regex(/^\d+$/u),
                    })
                    .passthrough(),
                )
                .nullable(),
            ),
          })
          .passthrough(),
      })
      .passthrough(),
  )
  .length(1);

const DockerImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const DockerSnapshotIdSchema = z.string().regex(/^im-docker-[a-f0-9]{64}$/u);
const DockerContainerIdSchema = z.string().regex(/^[a-f0-9]{12,64}$/u);
const DOCKER_COMMAND_TIMEOUT_MS = 30_000;
const DOCKER_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const AGENT_REQUEST_TIMEOUT_MS = 30_000;

interface DockerWorkspaceSdkOptions {
  readonly command?: DockerCommandPort;
  readonly imageRef: string;
  readonly fetcher?: typeof fetch;
  readonly clockMs?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface DockerSandboxProviderOptions extends Omit<
  ModalSandboxProviderOptions,
  'credentials' | 'sdkFactory'
> {
  readonly command?: DockerCommandPort;
  readonly fetcher?: typeof fetch;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createDockerCommandPort(): DockerCommandPort {
  return {
    run(args, timeoutMs = DOCKER_COMMAND_TIMEOUT_MS) {
      const parsedArgs = z.array(z.string()).min(1).parse(args);
      return new Promise((resolve, reject) => {
        execFile(
          'docker',
          parsedArgs,
          { timeout: timeoutMs, maxBuffer: DOCKER_MAX_BUFFER_BYTES, encoding: 'utf8' },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ exitCode: 0, stdout, stderr });
              return;
            }
            const code = (error as NodeJS.ErrnoException & { code?: string | number }).code;
            if (typeof code === 'number') {
              resolve({ exitCode: code, stdout, stderr });
              return;
            }
            reject(
              new Error(code === 'ENOENT' ? 'Docker CLI is unavailable' : 'Docker command failed'),
            );
          },
        );
      });
    },
  };
}

function imageReference(imageRef: string): string {
  const parsed = ImageBaseSchema.parse({ kind: 'registry', ref: imageRef });
  if (parsed.kind !== 'registry') throw new Error('Docker requires a registry image');
  return parsed.ref;
}

function runError(operation: string, result: DockerCommandResult): Error {
  return new Error(`Docker ${operation} failed with exit code ${String(result.exitCode)}`);
}

async function runOrThrow(
  command: DockerCommandPort,
  args: readonly string[],
  operation: string,
  timeoutMs?: number,
): Promise<DockerCommandResult> {
  const result = DockerCommandResultSchema.parse(await command.run(args, timeoutMs));
  if (result.exitCode !== 0) throw runError(operation, result);
  return result;
}

function networkName(sandboxName: string): string {
  return `${z
    .string()
    .regex(/^zapp-writer-[a-f0-9]{32}$/u)
    .parse(sandboxName)}-net`;
}

function cgroupName(sandboxName: string): string {
  return `${z
    .string()
    .regex(/^zapp-writer-[a-f0-9]{32}$/u)
    .parse(sandboxName)}-cgroup`;
}

function labels(input: ModalWorkspaceCreateOptions): readonly string[] {
  return [
    ...Object.entries(input.tags).flatMap(([name, value]) => ['--label', `zapp.${name}=${value}`]),
    '--label',
    `zapp.sandbox_name=${input.sandboxName}`,
  ];
}

function dockerEnvironmentVariables(
  environmentVariables: Readonly<Record<string, string>>,
): Record<string, string> {
  const ipv4First = '--dns-result-order=ipv4first';
  const existingNodeOptions = environmentVariables['NODE_OPTIONS']?.trim();
  return {
    ...environmentVariables,
    NODE_OPTIONS:
      existingNodeOptions === undefined || existingNodeOptions.length === 0
        ? ipv4First
        : existingNodeOptions.includes(ipv4First)
          ? existingNodeOptions
          : `${existingNodeOptions} ${ipv4First}`,
  };
}

function inspectNetworkName(inspect: z.infer<typeof DockerInspectSchema>[number]): string {
  const labelled = inspect.Config.Labels?.['zapp.sandbox_name'];
  if (labelled !== undefined) return networkName(labelled);
  const candidate = Object.keys(inspect.NetworkSettings.Networks).find((name) =>
    /^zapp-writer-[a-f0-9]{32}-net$/u.test(name),
  );
  if (candidate === undefined) throw new Error('Docker workspace network identity is missing');
  return candidate;
}

function portUrl(
  inspect: z.infer<typeof DockerInspectSchema>[number],
  containerPort: 8877 | 8080,
): URL {
  const mapping = inspect.NetworkSettings.Ports[`${String(containerPort)}/tcp`]?.[0];
  if (mapping === undefined || mapping.HostIp !== '127.0.0.1') {
    throw new Error('Docker workspace port is not bound to loopback');
  }
  return new URL(`http://127.0.0.1:${mapping.HostPort}`);
}

async function inspectContainer(
  command: DockerCommandPort,
  providerWorkspaceId: string,
): Promise<z.infer<typeof DockerInspectSchema>[number] | undefined> {
  const result = DockerCommandResultSchema.parse(
    await command.run(['container', 'inspect', providerWorkspaceId]),
  );
  if (result.exitCode !== 0) return undefined;
  return DockerInspectSchema.parse(JSON.parse(result.stdout) as unknown)[0];
}

function agentUrl(
  inspect: z.infer<typeof DockerInspectSchema>[number],
  request: AgentHttpRequest,
): string {
  const url = portUrl(inspect, 8877);
  url.pathname = z.string().startsWith('/').parse(request.path);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(name, value);
  }
  return url.href;
}

async function fetchAgent(
  fetcher: typeof fetch,
  inspect: z.infer<typeof DockerInspectSchema>[number],
  request: AgentHttpRequest,
  signal?: AbortSignal,
): Promise<Response> {
  return fetcher(agentUrl(inspect, request), {
    method: request.method,
    headers: { ...request.headers },
    ...(request.body === undefined ? {} : { body: Buffer.from(request.body) }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function dockerSnapshotId(untrustedDigest: string): string {
  const digest = DockerImageDigestSchema.parse(untrustedDigest);
  return ImageDigestSchema.parse(`im-docker-${digest.slice('sha256:'.length)}`);
}

export function providerSnapshotDigest(untrustedId: string): string {
  const id = DockerSnapshotIdSchema.parse(untrustedId);
  return DockerImageDigestSchema.parse(`sha256:${id.slice('im-docker-'.length)}`);
}

export function createDockerWorkspaceSdk(
  options: DockerWorkspaceSdkOptions,
): ModalWorkspaceSdkPort {
  const command = options.command ?? createDockerCommandPort();
  const imageRef = imageReference(options.imageRef);
  const fetcher = options.fetcher ?? fetch;
  const clockMs = options.clockMs ?? Date.now;
  const sleep = options.sleep ?? delay;

  async function createDelegatedCgroup(sandboxName: string): Promise<void> {
    const name = cgroupName(sandboxName);
    await runOrThrow(
      command,
      [
        'run',
        '--rm',
        '--privileged',
        '--cgroupns',
        'host',
        '--network',
        'none',
        '--entrypoint',
        '/bin/sh',
        imageRef,
        '-lc',
        `set -eu; install -d -m 0777 /sys/fs/cgroup/${name}`,
      ],
      'cgroup delegation',
    );
  }

  async function removeDelegatedCgroup(sandboxName: string): Promise<void> {
    const name = cgroupName(sandboxName);
    await runOrThrow(
      command,
      [
        'run',
        '--rm',
        '--privileged',
        '--cgroupns',
        'host',
        '--network',
        'none',
        '--entrypoint',
        '/bin/sh',
        imageRef,
        '-lc',
        `set -eu; if test -d /sys/fs/cgroup/${name}; then rmdir /sys/fs/cgroup/${name}; fi`,
      ],
      'cgroup cleanup',
    );
  }

  function adapt(
    initialInspect: z.infer<typeof DockerInspectSchema>[number],
  ): ModalWorkspaceSandbox {
    const providerWorkspaceId = DockerContainerIdSchema.parse(initialInspect.Id);

    async function current(): Promise<z.infer<typeof DockerInspectSchema>[number]> {
      const inspected = await inspectContainer(command, providerWorkspaceId);
      if (inspected === undefined) throw new ModalWorkspaceNotFoundError();
      return inspected;
    }

    return {
      providerWorkspaceId,
      async getTags() {
        const inspect = await current();
        const values = Object.fromEntries(
          Object.entries(inspect.Config.Labels ?? {}).flatMap(([name, value]) =>
            name.startsWith('zapp.') && name !== 'zapp.sandbox_name'
              ? [[name.slice('zapp.'.length), value]]
              : [],
          ),
        );
        return SandboxTagsSchema.parse(values);
      },
      async waitUntilReady(timeoutMs) {
        const deadline = clockMs() + z.number().int().positive().parse(timeoutMs);
        do {
          if ((await current()).State.Running) return;
          await sleep(Math.min(100, Math.max(1, deadline - clockMs())));
        } while (clockMs() < deadline);
        throw new Error('Docker workspace did not enter the running state');
      },
      async agentHealth(token) {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort();
        }, 2_000);
        try {
          const response = await fetchAgent(
            fetcher,
            await current(),
            {
              method: 'GET',
              path: '/healthz',
              headers: { authorization: `Bearer ${token}` },
            },
            controller.signal,
          );
          if (!response.ok) return { ok: false, details: 'workspace agent not ready' };
          return (await response.json()) as unknown;
        } catch {
          return { ok: false, details: 'workspace agent not ready' };
        } finally {
          clearTimeout(timeout);
        }
      },
      async agentRequest(request): Promise<AgentHttpResponse> {
        const response = await fetchAgent(
          fetcher,
          await current(),
          request,
          AbortSignal.timeout(request.timeoutMs ?? AGENT_REQUEST_TIMEOUT_MS),
        );
        const contentType = response.headers.get('content-type') ?? undefined;
        return {
          statusCode: response.status,
          ...(contentType === undefined ? {} : { contentType }),
          body: new Uint8Array(await response.arrayBuffer()),
        };
      },
      async agentStream(request): Promise<AgentHttpStream> {
        const controller = new AbortController();
        const response = await fetchAgent(fetcher, await current(), request, controller.signal);
        const contentType = response.headers.get('content-type') ?? undefined;
        const reader = response.body?.getReader();
        return {
          statusCode: response.status,
          ...(contentType === undefined ? {} : { contentType }),
          body: {
            async *[Symbol.asyncIterator]() {
              if (reader === undefined) return;
              for (;;) {
                const next = await reader.read();
                if (next.done) return;
                yield next.value;
              }
            },
          },
          async cancel() {
            controller.abort();
            await reader?.cancel().catch(() => undefined);
          },
        };
      },
      async tunnels() {
        const inspect = await current();
        const tunnels: Readonly<Record<number, ModalSdkTunnel>> = {
          8877: { url: portUrl(inspect, 8877).origin },
          8080: { url: portUrl(inspect, 8080).origin },
        };
        return tunnels;
      },
      async snapshotFilesystem() {
        const result = await runOrThrow(
          command,
          ['commit', providerWorkspaceId],
          'workspace snapshot',
          60_000,
        );
        return dockerSnapshotId(result.stdout.trim());
      },
      async updateNetworkPolicy(input) {
        const inspect = await current();
        const name = inspectNetworkName(inspect);
        const connected = Object.hasOwn(inspect.NetworkSettings.Networks, name);
        const restricted = input.outboundDomainAllowlist.length === 0;
        if (restricted && connected) {
          await runOrThrow(
            command,
            ['network', 'disconnect', name, providerWorkspaceId],
            'network restriction',
          );
        } else if (!restricted && !connected) {
          await runOrThrow(
            command,
            ['network', 'connect', name, providerWorkspaceId],
            'network restoration',
          );
        }
      },
      async terminate() {
        const inspect = await inspectContainer(command, providerWorkspaceId);
        if (inspect === undefined) return;
        const name = inspectNetworkName(inspect);
        const sandboxName = inspect.Config.Labels?.['zapp.sandbox_name'];
        if (sandboxName === undefined) throw new Error('Docker workspace identity is missing');
        const removal = DockerCommandResultSchema.parse(
          await command.run(['rm', '--force', providerWorkspaceId]),
        );
        if (removal.exitCode !== 0) throw runError('workspace termination', removal);
        const networkRemoval = DockerCommandResultSchema.parse(
          await command.run(['network', 'rm', name]),
        );
        if (networkRemoval.exitCode !== 0) {
          throw runError('workspace network cleanup', networkRemoval);
        }
        await removeDelegatedCgroup(sandboxName);
      },
    };
  }

  return {
    async createWorkspace(input) {
      const existing = await inspectContainer(command, input.sandboxName);
      if (existing !== undefined) throw new BranchLockedError(input.tags.branch_id);
      const name = networkName(input.sandboxName);
      const staleNetworkRemoval = await command.run(['network', 'rm', name]);
      if (![0, 1].includes(staleNetworkRemoval.exitCode)) {
        throw runError('stale network cleanup', staleNetworkRemoval);
      }
      await createDelegatedCgroup(input.sandboxName);
      try {
        await runOrThrow(command, ['network', 'create', name], 'network creation');
      } catch (error) {
        await removeDelegatedCgroup(input.sandboxName);
        throw error;
      }
      let containerId: string | undefined;
      try {
        await runOrThrow(command, ['volume', 'create', input.volume.name], 'cache volume creation');
        const created = await runOrThrow(
          command,
          [
            'run',
            '--detach',
            '--name',
            input.sandboxName,
            '--network',
            name,
            '--cgroupns',
            'host',
            '--mount',
            `type=bind,source=/sys/fs/cgroup/${cgroupName(input.sandboxName)},target=/sys/fs/cgroup`,
            '--stop-timeout',
            '10',
            '--cpus',
            String(input.resources.cpuLimit),
            '--memory',
            `${String(input.resources.memLimitMiB)}m`,
            '--volume',
            `${input.volume.name}:/cache`,
            '--volume',
            `${input.volume.name}:/workspace`,
            '--publish',
            '127.0.0.1::8877',
            '--publish',
            '127.0.0.1::8080',
            ...labels(input),
            ...Object.entries(dockerEnvironmentVariables(input.environmentVariables)).flatMap(
              ([envName, value]) => ['--env', `${envName}=${value}`],
            ),
            imageRef,
            ...input.command,
          ],
          'workspace creation',
          input.timeoutMs,
        );
        containerId = DockerContainerIdSchema.parse(created.stdout.trim());
        const inspect = await inspectContainer(command, containerId);
        if (inspect === undefined) throw new Error('Docker workspace disappeared after creation');
        return adapt(inspect);
      } catch (error) {
        if (containerId !== undefined) await command.run(['rm', '--force', containerId]);
        await command.run(['network', 'rm', name]);
        await removeDelegatedCgroup(input.sandboxName).catch(() => undefined);
        throw error;
      }
    },
    async getWorkspace(providerWorkspaceId) {
      const id = z.string().min(1).parse(providerWorkspaceId);
      const inspect = await inspectContainer(command, id);
      return inspect === undefined || !inspect.State.Running ? undefined : adapt(inspect);
    },
    async getWorkspaceForTermination(providerWorkspaceId) {
      const id = z.string().min(1).parse(providerWorkspaceId);
      const inspect = await inspectContainer(command, id);
      return inspect === undefined ? undefined : adapt(inspect);
    },
    async measureProjectVolumeBytes(input) {
      const exists = await command.run(['volume', 'inspect', input.volumeName]);
      if (exists.exitCode !== 0) return '0';
      const measured = await runOrThrow(
        command,
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--volume',
          `${input.volumeName}:/measure:ro`,
          imageRef,
          '/usr/bin/du',
          '-sb',
          '/measure',
        ],
        'cache volume measurement',
        120_000,
      );
      return z.string().regex(/^\d+$/u).parse(measured.stdout.trim().split(/\s+/u)[0]);
    },
    async deleteSnapshot(providerSnapshotId) {
      const result = await command.run(['image', 'rm', providerSnapshotDigest(providerSnapshotId)]);
      if (![0, 1].includes(result.exitCode)) throw runError('snapshot deletion', result);
    },
    async snapshotExists(providerSnapshotId) {
      const result = await command.run([
        'image',
        'inspect',
        providerSnapshotDigest(providerSnapshotId),
      ]);
      return result.exitCode === 0;
    },
    close() {},
  };
}

class DockerSandboxProvider extends ModalSandboxProvider {
  override readonly networkPolicyEnforcement = 'connectivity_only' as const;
  private readonly dockerSdkFactory: () => ModalWorkspaceSdkPort;

  constructor(options: DockerSandboxProviderOptions, imageRef: string) {
    const sdkFactory = () =>
      createDockerWorkspaceSdk({
        imageRef,
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        ...(options.clockMs === undefined ? {} : { clockMs: options.clockMs }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      });
    super({ ...options, sdkFactory });
    this.dockerSdkFactory = sdkFactory;
  }

  override async resolvePreviewTunnel(providerWorkspaceId: string): Promise<URL> {
    const id = z.string().min(1).parse(providerWorkspaceId);
    const sdk = this.dockerSdkFactory();
    try {
      const sandbox = await sdk.getWorkspace(id);
      if (sandbox === undefined) throw new ModalWorkspaceNotFoundError();
      const tunnel = (await sandbox.tunnels(30_000))[8080];
      if (tunnel === undefined) throw new Error('Workspace preview tunnel was not found');
      const url = new URL(tunnel.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
        throw new Error('Docker preview tunnel must remain on loopback');
      }
      return url;
    } finally {
      sdk.close();
    }
  }
}

export function createDockerSandboxProvider(
  options: DockerSandboxProviderOptions,
): ModalSandboxProvider {
  const lock = DockerImageLockSchema.parse(options.imageLock);
  const imageRef = imageReference(lock.publicMirrors['forge-node-base']);
  return new DockerSandboxProvider(options, imageRef);
}
