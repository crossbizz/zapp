import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AlreadyExistsError, ModalClient, NotFoundError, Probe } from 'modal';
import { z } from 'zod';
import {
  CleanupFailureResponseSchema,
  CreateWorkspaceInputSchema,
  ExecutionContractSchema,
  ExecInputSchema,
  RESOURCE_PROFILES,
  ResourceProfileSchema,
  WorkspaceHandleSchema,
  type CreateWorkspaceInput,
  type ExecutionContract,
  type ExecInput,
  type WorkspaceHandle,
  type WorkspacePurpose,
  type WorkspaceStatus,
} from '@zapp/contracts';
import {
  AgentHealthSchema,
  ImageDigestSchema,
  ImageSmokeEvidenceSchema,
  PublishedImageNameSchema,
  ModalCredentialsSchema,
  PublishImageInputSchema,
  PublishedImageSchema,
  SandboxTagsSchema,
  SmokeImageInputSchema,
  VerifyPublishedImageInputSchema,
  type ImageRecipe,
  type ModalCredentials,
  type ModalEnvironment,
  type ModalImagePublisher,
  type SandboxTags,
  type SourceFetchRevision,
} from './types.js';
import {
  BranchLockedError,
  createProjectVolumePlan,
  type ProjectVolumePlan,
} from './volumes.js';

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
const PreviewProxyHealthSchema = z.object({ status: z.literal('ok') }).strict();
const ExplicitKillProbeFailurePhaseSchema = z.enum([
  'started_wait',
  'request_completed_before_started',
  'identity_parse',
  'kill_request',
  'stream_completion',
  'kill_acknowledgement',
  'exit_record',
  'exit_code_validation',
]);
const ExplicitKillProbeDiagnosticSchema = z
  .object({ phase: ExplicitKillProbeFailurePhaseSchema })
  .strict();
type ExplicitKillProbeFailurePhase = z.infer<typeof ExplicitKillProbeFailurePhaseSchema>;

const HEALTH_PROBE_TIMEOUT_MS = 30_000;
const HEALTH_PROBE_INTERVAL_MS = 250;
const SCRIPTED_EXECUTION_TIMEOUT_MS = 30_000;
const EXPLICIT_KILL_START_POLL_INTERVAL_MS = 25;

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
  readonly tags: SandboxTags;
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly experimentalOptions: Readonly<{ vm_runtime: true }>;
  readonly encryptedPorts: readonly [8877, 8080];
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
  readonly sdkFactory?: (environment: ModalEnvironment) => ModalSdkPort;
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
  return imageDockerfileLayers(recipe).flatMap((layer) => layer.commands);
}

interface DockerfileBuildLayer {
  readonly kind: 'plain' | 'source-fetch';
  readonly commands: string[];
}

const SOURCE_DIRECTORY = '/tmp/zapp-src';
const ASKPASS_DIRECTORY = '/tmp/zapp-source-fetch';
const ASKPASS_PATH = `${ASKPASS_DIRECTORY}/askpass`;
const CREDENTIAL_CONFIG_PATTERN = '^(credential\\.|core\\.[Aa]sk[Pp]ass$|http\\..*\\.extraheader)';

function sourceFetchCommand(source: SourceFetchRevision): string {
  return `RUN set -eu; umask 077; test ! -e ${ASKPASS_DIRECTORY}; mkdir ${ASKPASS_DIRECTORY}; cleanup() { rm -rf ${ASKPASS_DIRECTORY}; }; trap cleanup EXIT; trap 'exit 1' HUP INT TERM; printf '%s\\n' '#!/bin/sh' 'case "$1" in' '*Username*) printf "%s\\n" "x-access-token" ;;' '*) printf "%s\\n" "$ZAPP_GITHUB_READ_TOKEN" ;;' 'esac' > ${ASKPASS_PATH}; chmod 0700 ${ASKPASS_PATH}; GIT_ASKPASS=${ASKPASS_PATH} GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --filter=blob:none --no-checkout ${shellQuote(source.repositoryUrl)} ${SOURCE_DIRECTORY}; cd ${SOURCE_DIRECTORY}; GIT_ASKPASS=${ASKPASS_PATH} GIT_TERMINAL_PROMPT=0 git -c credential.helper= fetch --depth=1 origin ${shellQuote(source.commitSha)}; GIT_ASKPASS=${ASKPASS_PATH} GIT_TERMINAL_PROMPT=0 git -c credential.helper= checkout --detach FETCH_HEAD; test "$(git rev-parse HEAD)" = ${shellQuote(source.commitSha)}`;
}

function credentialAbsenceCommand(includeProcessEnvironments: boolean): string {
  const directEnvironmentChecks = [
    'ZAPP_GITHUB_READ_TOKEN',
    'GIT_ASKPASS',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_NOSYSTEM',
  ]
    .map((name) => `test -z "\${${name}+x}"`)
    .join('; ');
  const processCheck = includeProcessEnvironments
    ? "; for process_environment in /proc/[0-9]*/environ; do if test -r \"$process_environment\" && tr '\\0' '\\n' < \"$process_environment\" 2>/dev/null | grep -Eq '^(ZAPP_GITHUB_READ_TOKEN|GIT_ASKPASS|GIT_CONFIG_(COUNT|GLOBAL|SYSTEM|NOSYSTEM|KEY_[0-9]+|VALUE_[0-9]+))='; then exit 1; fi; done"
    : '';
  return `set -eu; ${directEnvironmentChecks}; test ! -e ${ASKPASS_PATH}; test ! -e ${ASKPASS_DIRECTORY}; test ! -e /root/.git-credentials; test ! -e /root/.config/git/credentials; test -z "$(git config --system --get-regexp '${CREDENTIAL_CONFIG_PATTERN}' || true)"; test -z "$(git config --global --get-regexp '${CREDENTIAL_CONFIG_PATTERN}' || true)"; test -z "$(git -C ${SOURCE_DIRECTORY} config --local --get-regexp '${CREDENTIAL_CONFIG_PATTERN}' || true)"; remote_url=$(git -C ${SOURCE_DIRECTORY} remote get-url origin); case "$remote_url" in https://github.com/*) ;; *) exit 1 ;; esac; case "\${remote_url#https://}" in *@*) exit 1 ;; esac${processCheck}`;
}

function imageDockerfileLayers(recipe: ImageRecipe): DockerfileBuildLayer[] {
  const files = fileCommands(recipe);
  const layers: DockerfileBuildLayer[] = [
    ...(files.length === 0 ? [] : [{ kind: 'plain' as const, commands: files }]),
  ];
  for (const layer of recipe.layers) {
    if (layer.kind === 'source-fetch') {
      layers.push(
        { kind: 'source-fetch', commands: [sourceFetchCommand(layer.source)] },
        { kind: 'plain', commands: [`RUN ${credentialAbsenceCommand(false)}`] },
      );
    } else {
      layers.push(layer);
    }
  }
  return layers;
}

function credentialsFromEnvironment(): ModalCredentials {
  return ModalCredentialsSchema.parse({
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
  });
}

function createSdkPort(credentials: ModalCredentials, environment: ModalEnvironment): ModalSdkPort {
  const parsedCredentials = ModalCredentialsSchema.parse(credentials);
  const client = new ModalClient({
    tokenId: parsedCredentials.tokenId,
    tokenSecret: parsedCredentials.tokenSecret,
    environment,
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
      let image = base;
      for (const layer of imageDockerfileLayers(input.recipe)) {
        if (layer.kind === 'source-fetch') {
          const sourceReadSecret = await client.secrets.fromName('zapp-github-source-read', {
            environment: input.environment,
            requiredKeys: ['ZAPP_GITHUB_READ_TOKEN'],
          });
          image = image.dockerfileCommands(layer.commands, { secrets: [sourceReadSecret] });
        } else {
          image = image.dockerfileCommands(layer.commands);
        }
      }
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
      let sandbox: Awaited<ReturnType<typeof client.sandboxes.create>>;
      try {
        sandbox = await client.sandboxes.create(app, image, {
          command: ['/usr/bin/dumb-init', '--', '/opt/zapp/boot.sh'],
          env: { ...input.environmentVariables },
          tags: { ...input.tags },
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

async function execExplicitKillProbeOrThrow(
  sandbox: ModalSdkSandboxPort,
  command: string[],
  purpose: string,
): Promise<ModalSdkRunResult> {
  const result = ModalSdkRunResultSchema.parse(await sandbox.exec(command));
  if (result.exitCode !== 0) {
    let diagnostic: z.infer<typeof ExplicitKillProbeDiagnosticSchema> | undefined;
    try {
      const parsed = ExplicitKillProbeDiagnosticSchema.safeParse(
        JSON.parse(result.stdout) as unknown,
      );
      if (parsed.success) diagnostic = parsed.data;
    } catch {
      // Only the closed diagnostic schema may cross this boundary.
    }
    const suffix = diagnostic === undefined ? '' : ` (phase: ${diagnostic.phase})`;
    throw new Error(`${purpose} failed with exit code ${String(result.exitCode)}${suffix}`);
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
  const response = ModalSdkRunResultSchema.parse(
    await sandbox.exec(
      authenticatedCurlTo(token, authenticatedAgentUrl(`/exec/cleanup/${cleanupId}`)),
    ),
  );
  if (response.exitCode !== 0) {
    let diagnostic = undefined;
    try {
      diagnostic = CleanupFailureResponseSchema.safeParse(JSON.parse(response.stdout) as unknown);
    } catch {
      // Only the closed diagnostic schema may cross this boundary.
    }
    if (diagnostic?.success === true) {
      throw new Error(
        `containment cleanup acknowledgement failed (stage: ${diagnostic.data.stage})`,
      );
    }
    throw new Error('containment cleanup acknowledgement failed');
  }
  CleanupResponseSchema.parse(JSON.parse(response.stdout) as unknown);
}

function detachedChildCommand(marker: string): string {
  return `setsid sh -c 'sleep 1; echo escaped > ${marker}' >/dev/null 2>&1 & sleep 30`;
}

function explicitKillPhaseFailure(phase: ExplicitKillProbeFailurePhase): string {
  const diagnostic = ExplicitKillProbeDiagnosticSchema.parse({ phase });
  return `(failure_status=$? && printf '%s\\n' ${shellQuote(JSON.stringify(diagnostic))} && exit "$failure_status")`;
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
  label: 'disconnect' | 'explicit-kill',
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
    timeoutMs: SCRIPTED_EXECUTION_TIMEOUT_MS,
    pty,
  });
  if (label === 'disconnect') {
    return `set -eu; rm -f ${output}; set +e; curl --max-time 0.25 --silent --show-error ${execHeaders} --request POST --data ${shellQuote(detachedBody)} ${shellQuote(executionUrl)} > ${output}; status=$?; set -e; test "$status" -ne 0`;
  }

  const pollIntervalSeconds = (EXPLICIT_KILL_START_POLL_INTERVAL_MS / 1_000).toFixed(3);
  const executionTimeoutSeconds = SCRIPTED_EXECUTION_TIMEOUT_MS / 1_000;
  return `set -eu; rm -f ${output}; curl --no-buffer --silent --show-error ${execHeaders} --request POST --data ${shellQuote(detachedBody)} ${shellQuote(executionUrl)} > ${output} & request_pid=$!; sleep ${String(executionTimeoutSeconds)} & start_deadline_pid=$!; started=false; request_completed=false; deadline_alive=true; while :; do if grep -q '"type":"started"' ${output}; then started=true; break; fi; request_alive=true; if ! kill -0 "$request_pid" 2>/dev/null; then request_alive=false; fi; deadline_alive=true; if ! kill -0 "$start_deadline_pid" 2>/dev/null; then deadline_alive=false; fi; if test "$request_alive" = false; then if grep -q '"type":"started"' ${output}; then started=true; elif test "$deadline_alive" = true; then request_completed=true; fi; break; fi; if test "$deadline_alive" = false; then break; fi; sleep ${pollIntervalSeconds}; done; if test "$deadline_alive" = true; then kill "$start_deadline_pid" 2>/dev/null || true; fi; wait "$start_deadline_pid" 2>/dev/null || true; test "$request_completed" = false || ${explicitKillPhaseFailure('request_completed_before_started')}; test "$started" = true || ${explicitKillPhaseFailure('started_wait')}; pid=$(jq -ser 'map(select(.type == "started"))[0].pid' ${output}) || ${explicitKillPhaseFailure('identity_parse')}; generation=$(jq -ser 'map(select(.type == "started"))[0].executionId' ${output}) || ${explicitKillPhaseFailure('identity_parse')}; test -n "$pid" || ${explicitKillPhaseFailure('identity_parse')}; test -n "$generation" || ${explicitKillPhaseFailure('identity_parse')}; kill_body=$(printf '{"executionId":"%s"}' "$generation"); kill_result=$(curl --fail-with-body --silent --show-error ${killHeaders} --request POST --data "$kill_body" "http://127.0.0.1:8877/exec/$pid/kill") || ${explicitKillPhaseFailure('kill_request')}; wait "$request_pid" || ${explicitKillPhaseFailure('stream_completion')}; test "$(printf %s "$kill_result" | jq -r .killed)" = 'true' || ${explicitKillPhaseFailure('kill_acknowledgement')}; exit_code=$(jq -ser 'map(select(.type == "exit"))[-1].exitCode' ${output}) || ${explicitKillPhaseFailure('exit_record')}; test "$exit_code" -ne 0 || ${explicitKillPhaseFailure('exit_code_validation')}`;
}

async function probeScriptedLifecycle(
  sandbox: ModalSdkSandboxPort,
  token: string,
  label: 'disconnect' | 'explicit-kill',
  pty: boolean,
): Promise<void> {
  const cleanupId = randomUUID();
  const scenario = `${label}-${pty ? 'pty' : 'buffered'}`;
  const command = ['sh', '-lc', agentRequestScript(token, cleanupId, label, pty)];
  if (label === 'explicit-kill') {
    await execExplicitKillProbeOrThrow(sandbox, command, `${scenario} cleanup probe`);
  } else {
    await execOrThrow(sandbox, command, `${scenario} cleanup probe`);
  }
  await acknowledgeCleanup(sandbox, token, cleanupId);
  await execOrThrow(
    sandbox,
    ['sh', '-lc', `sleep 2; test ! -e /tmp/zapp-${scenario}-escaped`],
    `${scenario} detached-child probe`,
  );
}

async function probePidOwnership(sandbox: ModalSdkSandboxPort, token: string): Promise<void> {
  const cleanupA = randomUUID();
  const cleanupB = randomUUID();
  const outputA = '/tmp/zapp-pid-ownership-a.ndjson';
  const outputB = '/tmp/zapp-pid-ownership-b.ndjson';
  const commonHeaders = `--header ${shellQuote(`Authorization: Bearer ${token}`)} --header 'Content-Type: application/json'`;
  const bodyA = JSON.stringify({ cmd: 'true', args: [], timeoutMs: 5_000, pty: false });
  const bodyB = JSON.stringify({
    cmd: 'sh',
    args: ['-lc', detachedChildCommand('/tmp/zapp-pid-ownership-escaped')],
    timeoutMs: 30_000,
    pty: false,
  });
  const script = `set -eu; rm -f ${outputA} ${outputB}; curl --silent --show-error ${commonHeaders} --header ${shellQuote(`Idempotency-Key: ${randomUUID()}`)} --request POST --data ${shellQuote(bodyA)} ${shellQuote(authenticatedAgentUrl('/exec?stream=1', cleanupA))} > ${outputA}; generation_a=$(jq -ser 'map(select(.type == "started"))[0].executionId' ${outputA}); test -n "$generation_a"; curl --no-buffer --silent --show-error ${commonHeaders} --header ${shellQuote(`Idempotency-Key: ${randomUUID()}`)} --request POST --data ${shellQuote(bodyB)} ${shellQuote(authenticatedAgentUrl('/exec?stream=1', cleanupB))} > ${outputB} & request_b_pid=$!; for _ in $(seq 1 200); do grep -q '"type":"started"' ${outputB} && break; sleep 0.025; done; pid_b=$(jq -ser 'map(select(.type == "started"))[0].pid' ${outputB}); generation_b=$(jq -ser 'map(select(.type == "started"))[0].executionId' ${outputB}); test -n "$pid_b"; test -n "$generation_b"; kill -0 "$request_b_pid"; stale_body=$(printf '{"executionId":"%s"}' "$generation_a"); stale_result=$(curl --fail-with-body --silent --show-error ${commonHeaders} --header ${shellQuote(`Idempotency-Key: ${randomUUID()}`)} --request POST --data "$stale_body" "http://127.0.0.1:8877/exec/$pid_b/kill"); test "$(printf %s "$stale_result" | jq -r .killed)" = 'false'; kill -0 "$request_b_pid"; current_body=$(printf '{"executionId":"%s"}' "$generation_b"); current_result=$(curl --fail-with-body --silent --show-error ${commonHeaders} --header ${shellQuote(`Idempotency-Key: ${randomUUID()}`)} --request POST --data "$current_body" "http://127.0.0.1:8877/exec/$pid_b/kill"); test "$(printf %s "$current_result" | jq -r .killed)" = 'true'; wait "$request_b_pid"; exit_code=$(jq -ser 'map(select(.type == "exit"))[-1].exitCode' ${outputB}); test "$exit_code" -ne 0`;
  await execOrThrow(sandbox, ['sh', '-lc', script], 'pid-ownership cleanup probe');
  await acknowledgeCleanup(sandbox, token, cleanupA);
  await acknowledgeCleanup(sandbox, token, cleanupB);
  await execOrThrow(
    sandbox,
    ['sh', '-lc', 'sleep 2; test ! -e /tmp/zapp-pid-ownership-escaped'],
    'pid-ownership detached-child probe',
  );
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
  return `set -eu; rm -f ${ready} ${cleaned} ${escaped} ${output}; node --input-type=module -e ${shellQuote(childProgram)} & agent_pid=$!; for _ in $(seq 1 200); do test -e ${ready} && break; sleep 0.025; done; test -e ${ready}; curl --no-buffer --silent --show-error ${headers} --request POST --data ${shellQuote(body)} ${shellQuote(url)} >${output} & request_pid=$!; for _ in $(seq 1 200); do grep -q '"type":"started"' ${output} && break; sleep 0.025; done; pid=$(jq -ser 'map(select(.type == "started"))[0].pid' ${output}); generation=$(jq -ser 'map(select(.type == "started"))[0].executionId' ${output}); test -n "$pid"; test -n "$generation"; printf %s "$pid" | grep -Eq '^[1-9][0-9]*$'; printf %s "$generation" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; kill -0 "$request_pid"; kill -TERM "$agent_pid"; wait "$agent_pid"; wait "$request_pid" || true; test -e ${cleaned}; sleep 2; test ! -e ${escaped}`;
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
      const health = CompatibleAgentHealthSchema.safeParse(JSON.parse(response.stdout) as unknown);
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
  const tags = SandboxTagsSchema.parse({
    org_id: 'smoke_org_ws_2',
    project_id: 'smoke_project_ws_2',
    branch_id: 'smoke_branch_ws_2',
    run_id: 'smoke_run_ws_2',
    task_id: 'smoke_task_ws_2',
    purpose: 'image_smoke',
    environment: input.environment,
  });

  const sandbox = await sdk.createVmSandbox({
    environment: input.environment,
    appName: input.appName,
    digest: input.digest,
    publishedName: input.publishedName,
    tags,
    environmentVariables,
    experimentalOptions: { vm_runtime: true },
    encryptedPorts: [8877, 8080],
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
    PreviewProxyHealthSchema.parse(
      JSON.parse(
        (
          await execOrThrow(
            sandbox,
            [
              'curl',
              '--fail-with-body',
              '--silent',
              '--show-error',
              'http://127.0.0.1:8080/__zapp/healthz',
            ],
            'preview proxy health probe',
          )
        ).stdout,
      ) as unknown,
    );
    await execOrThrow(
      sandbox,
      ['sh', '-lc', credentialAbsenceCommand(true)],
      'source credential absence probe',
    );
    await execOrThrow(
      sandbox,
      [
        'sh',
        '-lc',
        [
          'set -eu',
          'probe=$(mktemp -d)',
          'trap \'rm -rf "$probe"\' EXIT INT TERM',
          'cd "$probe"',
          'git init --quiet',
          'git config user.email smoke@zapp.invalid',
          'git config user.name zapp-smoke',
          'printf safe > app.ts',
          'git add app.ts',
          'git commit --quiet -m base',
          'base=$(git rev-parse HEAD)',
          'secret=$(printf %s%s%s sk_ live_ 51H8z7aQ3mT9vK2pL6nR4cD8sF1wY5uB7eG0jN2xP9qA)',
          'printf \'export const token = "%s";\\n\' "$secret" > app.ts',
          'git add app.ts',
          'git commit --quiet -m planted',
          'set +e',
          'gitleaks git --no-banner --log-level=error --redact=100 --report-format=json --report-path=report.json --log-opts="$base..HEAD" .',
          'status=$?',
          'set -e',
          'test "$status" -eq 1',
          'jq -e \'length == 1 and .[0].File == "app.ts" and .[0].StartLine == 1\' report.json >/dev/null',
          '! grep -F "$secret" report.json',
        ].join('; '),
      ],
      'gitleaks planted-secret probe',
    );

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
    await probePidOwnership(sandbox, input.agentToken);

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
        previewProxyHealth: true,
        volumeReadWrite: true,
        filesystemSnapshot: snapshotDigest,
        encryptedTunnel: true,
        readinessProbe: true,
        gitleaksSecretScan: true,
      },
      credentialAbsence: {
        environment: true,
        gitConfiguration: true,
        askpassPath: true,
        processEnvironment: true,
      },
      terminated: true,
    });
  } finally {
    await sandbox.terminate();
  }
}

const WorkspaceEnvironmentNameSchema = z.enum(['dev', 'staging', 'prod']);
type WorkspaceEnvironmentName = z.infer<typeof WorkspaceEnvironmentNameSchema>;

const ModalImageLockSchema = z
  .object({
    version: z.literal(1),
    environments: z.record(
      WorkspaceEnvironmentNameSchema,
      z
        .object({
          modalEnvironment: z.enum(['zapp-dev', 'zapp-staging', 'zapp-prod']),
          sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
          tag: z.string().min(1),
          images: z
            .object({
              'forge-node-base': z
                .object({
                  appName: z.literal('zapp-workspaces'),
                  digest: ImageDigestSchema,
                  publishedName: PublishedImageNameSchema,
                })
                .strict(),
              'forge-web-test': z
                .object({
                  appName: z.literal('zapp-browser-verify'),
                  digest: ImageDigestSchema,
                  publishedName: PublishedImageNameSchema,
                })
                .strict(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();
export type ModalImageLock = z.infer<typeof ModalImageLockSchema>;

export interface ModalWorkspaceCreateOptions {
  readonly environment: ModalEnvironment;
  /** One runtime App keeps branch-unique Sandbox names global across image purposes. */
  readonly appName: 'zapp-workspaces';
  readonly digest: string;
  readonly publishedName: string;
  readonly tags: SandboxTags;
  readonly resources: Readonly<{
    cpuRequest: number;
    cpuLimit: number;
    memRequestMiB: number;
    memLimitMiB: number;
  }>;
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly sandboxName: string;
  readonly volume: Readonly<{
    name: string;
    mounts: readonly [
      Readonly<{ mountPath: '/cache'; subPath: '/cache' }>,
    ];
  }>;
  readonly command: readonly string[];
  readonly encryptedPorts: readonly [8877, 8080];
  readonly readinessProbe: Readonly<{ kind: 'tcp'; port: 8877; intervalMs: 250 }>;
  readonly timeoutMs: number;
}

export interface ModalWorkspaceSandbox {
  readonly providerWorkspaceId: string;
  getTags(): Promise<Readonly<Record<string, string>>>;
  waitUntilReady(timeoutMs: number): Promise<void>;
  agentHealth(token: string): Promise<unknown>;
  agentRequest(request: AgentHttpRequest): Promise<AgentHttpResponse>;
  agentStream(request: AgentHttpRequest): Promise<AgentHttpStream>;
  tunnels(timeoutMs: number): Promise<Readonly<Record<number, ModalSdkTunnel>>>;
  terminate(): Promise<void>;
}

export interface AgentHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface AgentHttpResponse {
  readonly statusCode: number;
  readonly contentType?: string;
  readonly body: Uint8Array;
}

export interface AgentHttpStream {
  readonly statusCode: number;
  readonly contentType?: string;
  readonly body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void>;
}

export interface ModalWorkspaceSdkPort {
  createWorkspace(input: ModalWorkspaceCreateOptions): Promise<ModalWorkspaceSandbox>;
  getWorkspace(providerWorkspaceId: string): Promise<ModalWorkspaceSandbox | undefined>;
  close(): void;
}

export interface ModalSandboxProviderOptions {
  readonly environment: WorkspaceEnvironmentName;
  readonly imageLock: unknown;
  readonly agentToken: string;
  readonly credentials?: ModalCredentials;
  readonly sdkFactory?: (environment: ModalEnvironment) => ModalWorkspaceSdkPort;
  readonly now?: () => Date;
  readonly clockMs?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export const ModalWorkspaceAttachmentSchema = z
  .object({
    resourceProfile: ResourceProfileSchema,
    imageTag: PublishedImageNameSchema,
    createdAt: z.coerce.date(),
    requiredTags: SandboxTagsSchema,
  })
  .strict();
export type ModalWorkspaceAttachment = z.infer<typeof ModalWorkspaceAttachmentSchema>;

const WORKSPACE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const WORKSPACE_ENV_ALLOWLIST = new Set([
  'PLAYWRIGHT_BROWSERS_PATH',
  'PNPM_STORE_DIR',
  'ZAPP_TELEMETRY_ENDPOINT',
]);
const CompatibleAgentHealthSchema = z.union([
  AgentHealthSchema,
  z
    .object({ ok: z.literal(true), details: z.string().min(1) })
    .strict()
    .transform((health) => ({ ...health, devServer: null })),
]);
const WorkspaceAgentHealthSchema = z.union([
  CompatibleAgentHealthSchema,
  z.object({ ok: z.literal(false), details: z.string().min(1) }).strict(),
]);
const WorkspaceAgentExecResultSchema = z
  .object({
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().finite().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type WorkspaceAgentExecResult = z.infer<typeof WorkspaceAgentExecResultSchema>;
const WorkspaceAgentStreamRecordSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('started'),
      pid: z.number().int().positive(),
      executionId: z.string().uuid(),
      at: z.string().datetime(),
    })
    .strict(),
  z
    .object({ type: z.enum(['stdout', 'stderr']), data: z.string(), at: z.string().datetime() })
    .strict(),
  z
    .object({
      type: z.literal('exit'),
      exitCode: z.number().int(),
      durationMs: z.number().finite().nonnegative(),
      truncated: z.boolean(),
      at: z.string().datetime(),
    })
    .strict(),
]);
export type WorkspaceAgentStreamRecord = z.infer<typeof WorkspaceAgentStreamRecordSchema>;
const KillResponseSchema = z.object({ killed: z.boolean() }).strict();
const FileEntrySchema = z
  .object({ path: z.string(), type: z.enum(['file', 'directory', 'symlink']) })
  .strict();
const FileListSchema = z.array(FileEntrySchema);
const GitInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.enum(['status', 'diff', 'log', 'show', 'push', 'checkout', 'branch', 'restore']),
      args: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('add_commit'),
      paths: z.array(z.string()).min(1),
      message: z.string().min(1),
    })
    .strict(),
]);
const GitResultSchema = z
  .object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
  .strict();
const DevServerEvidenceSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    supervisorId: z.string().min(1),
    owned: z.boolean(),
    httpReady: z.boolean(),
  })
  .strict();
const HealthResponseSchema = z
  .object({
    ok: z.boolean(),
    details: z.string(),
    devServer: DevServerEvidenceSchema.nullable(),
  })
  .strict();
const MetricsResponseSchema = z
  .object({
    at: z.string().datetime(),
    activeChildren: z.number().int().nonnegative(),
    cpu: z
      .object({ userMicros: z.number().nonnegative(), systemMicros: z.number().nonnegative() })
      .strict(),
    memory: z
      .object({
        rssBytes: z.number().nonnegative(),
        heapTotalBytes: z.number().nonnegative(),
        heapUsedBytes: z.number().nonnegative(),
        externalBytes: z.number().nonnegative(),
        arrayBuffersBytes: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();
const AtomicFileWriteSchema = z
  .object({
    path: z.string().min(1),
    data: z.instanceof(Uint8Array),
    expectedRevision: z.string().min(1).optional(),
  })
  .strict();
const SearchInputSchema = z
  .object({
    pattern: z.string(),
    path: z.string().min(1),
    glob: z.string().min(1).optional(),
    fixedStrings: z.boolean().optional(),
    ignoreCase: z.boolean().optional(),
  })
  .strict();
const RenameInputSchema = z
  .object({
    source: z.string().min(1),
    destination: z.string().min(1),
    overwrite: z.literal('replace'),
  })
  .strict();
const OkResponseSchema = z.object({ ok: z.literal(true) }).strict();
const DeleteResponseSchema = z.object({ ok: z.literal(true), alreadyAbsent: z.boolean() }).strict();
const DevServerResponseSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    pid: z.number().int().positive(),
    supervisorId: z.string().min(1),
    ownership: z.enum(['process', 'process_group']),
  })
  .strict();
const DevServerLogsQuerySchema = z
  .object({
    after: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(1_000),
  })
  .strict();
const DevServerLogsResponseSchema = z
  .object({
    entries: z.array(
      z
        .object({
          cursor: z.number().int().positive(),
          at: z.string().datetime(),
          stream: z.enum(['stdout', 'stderr']),
          message: z.string(),
        })
        .strict(),
    ),
    nextCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
    state: z.enum(['idle', 'starting', 'ready', 'restarting', 'failed']),
    failureId: z.string().min(1).nullable(),
  })
  .strict();
const AtomicConflictResponseSchema = z
  .object({ error: z.literal('atomic_write_conflict') })
  .strict();

export class ModalAtomicWriteConflictError extends Error {
  readonly code = 'atomic_write_conflict' as const;

  constructor() {
    super('Atomic file changed before commit');
    this.name = 'AtomicWriteConflictError';
  }
}

export class ModalWorkspaceNotFoundError extends Error {
  constructor() {
    super('Workspace sandbox was not found');
    this.name = 'ModalWorkspaceNotFoundError';
  }
}

export class ModalWorkspaceTagMismatchError extends Error {
  constructor() {
    super('Workspace sandbox tags do not match the persisted workspace');
    this.name = 'ModalWorkspaceTagMismatchError';
  }
}

export class ModalWorkspaceReadinessError extends Error {
  constructor(options?: ErrorOptions) {
    super('Workspace sandbox did not become ready', options);
    this.name = 'ModalWorkspaceReadinessError';
  }
}

function jsonAgentBody(response: AgentHttpResponse): unknown {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Workspace agent rejected the request with status ${String(response.statusCode)}`,
    );
  }
  if (!response.contentType?.startsWith('application/json')) {
    throw new Error('Workspace agent returned an unexpected content type');
  }
  try {
    return JSON.parse(Buffer.from(response.body).toString('utf8')) as unknown;
  } catch {
    throw new Error('Workspace agent returned malformed JSON');
  }
}

function jsonAgentBodyWithConflict(response: AgentHttpResponse): unknown {
  if (response.statusCode === 409 && response.contentType?.startsWith('application/json')) {
    try {
      AtomicConflictResponseSchema.parse(JSON.parse(Buffer.from(response.body).toString('utf8')));
    } catch {
      throw new Error('Workspace agent returned an invalid conflict response');
    }
    throw new ModalAtomicWriteConflictError();
  }
  return jsonAgentBody(response);
}

function expectNoContent(response: AgentHttpResponse): void {
  if (response.statusCode !== 204 || response.body.byteLength !== 0) {
    throw new Error('Workspace agent returned an invalid empty response');
  }
}

function createModalWorkspaceSdk(
  credentials: ModalCredentials,
  environment: ModalEnvironment,
): ModalWorkspaceSdkPort {
  const parsedCredentials = ModalCredentialsSchema.parse(credentials);
  const client = new ModalClient({
    tokenId: parsedCredentials.tokenId,
    tokenSecret: parsedCredentials.tokenSecret,
    environment,
  });

  function adapt(
    sandbox: Awaited<ReturnType<typeof client.sandboxes.fromId>>,
  ): ModalWorkspaceSandbox {
    return {
      providerWorkspaceId: sandbox.sandboxId,
      async getTags() {
        return sandbox.getTags();
      },
      async waitUntilReady(timeoutMs) {
        await sandbox.waitUntilReady(timeoutMs);
      },
      async agentHealth(token) {
        const response = ModalSdkRunResultSchema.parse(
          await (async () => {
            try {
              const process = await sandbox.exec(authenticatedCurl(token, '/healthz'), {
                mode: 'text',
                timeoutMs: 2_000,
              });
              const [stdout, stderr, exitCode] = await Promise.all([
                process.stdout.readText(),
                process.stderr.readText(),
                process.wait(),
              ]);
              return { stdout, stderr, exitCode };
            } catch {
              return { stdout: '', stderr: '', exitCode: 1 };
            }
          })(),
        );
        if (response.exitCode !== 0) return { ok: false, details: 'workspace agent not ready' };
        try {
          return WorkspaceAgentHealthSchema.parse(JSON.parse(response.stdout) as unknown);
        } catch {
          return { ok: false, details: 'workspace agent returned an invalid health response' };
        }
      },
      async tunnels(timeoutMs) {
        const tunnels = await sandbox.tunnels(timeoutMs);
        return Object.fromEntries(
          Object.entries(tunnels).map(([port, tunnel]) => [port, { url: tunnel.url }]),
        );
      },
      async agentRequest(request) {
        const query = new URLSearchParams(request.query).toString();
        const url = `http://127.0.0.1:8877${request.path}${query === '' ? '' : `?${query}`}`;
        const encoded = Buffer.from(
          JSON.stringify({
            method: request.method,
            url,
            headers: request.headers,
            bodyBase64:
              request.body === undefined ? undefined : Buffer.from(request.body).toString('base64'),
          }),
        ).toString('base64');
        const script = [
          "let encoded = ''; for await (const chunk of process.stdin) encoded += chunk;",
          "const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));",
          "const response = await fetch(input.url, { method: input.method, headers: input.headers, body: input.bodyBase64 === undefined ? undefined : Buffer.from(input.bodyBase64, 'base64') });",
          'const body = Buffer.from(await response.arrayBuffer());',
          "process.stdout.write(JSON.stringify({ statusCode: response.status, contentType: response.headers.get('content-type') ?? undefined, bodyBase64: body.toString('base64') }));",
        ].join('\n');
        const process = await sandbox.exec(['node', '--input-type=module', '-e', script], {
          mode: 'text',
          timeoutMs: 30_000,
        });
        const writer = process.stdin.getWriter();
        try {
          await writer.write(encoded);
          await writer.close();
        } catch (error) {
          await process.closeStdin().catch(() => undefined);
          throw error;
        } finally {
          writer.releaseLock();
        }
        const [stdout, exitCode] = await Promise.all([process.stdout.readText(), process.wait()]);
        if (exitCode !== 0) throw new Error('Workspace agent request failed');
        const response = z
          .object({
            statusCode: z.number().int().min(100).max(599),
            contentType: z.string().optional(),
            bodyBase64: z.string(),
          })
          .strict()
          .parse(JSON.parse(stdout) as unknown);
        return {
          statusCode: response.statusCode,
          ...(response.contentType === undefined ? {} : { contentType: response.contentType }),
          body: Buffer.from(response.bodyBase64, 'base64'),
        };
      },
      async agentStream(request) {
        const query = new URLSearchParams(request.query).toString();
        const url = `http://127.0.0.1:8877${request.path}${query === '' ? '' : `?${query}`}`;
        const encoded = Buffer.from(
          JSON.stringify({
            method: request.method,
            url,
            headers: request.headers,
            bodyBase64:
              request.body === undefined ? undefined : Buffer.from(request.body).toString('base64'),
          }),
        ).toString('base64');
        const script = [
          "let encoded = ''; for await (const chunk of process.stdin) encoded += chunk;",
          "const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));",
          "const response = await fetch(input.url, { method: input.method, headers: input.headers, body: input.bodyBase64 === undefined ? undefined : Buffer.from(input.bodyBase64, 'base64') });",
          "process.stdout.write(JSON.stringify({ statusCode: response.status, contentType: response.headers.get('content-type') ?? undefined }) + '\\n');",
          'if (response.body !== null) for await (const chunk of response.body) process.stdout.write(Buffer.from(chunk));',
        ].join('\n');
        const process = await sandbox.exec(['node', '--input-type=module', '-e', script], {
          mode: 'text',
          timeoutMs: WORKSPACE_TIMEOUT_MS,
        });
        const writer = process.stdin.getWriter();
        try {
          await writer.write(encoded);
          await writer.close();
        } catch (error) {
          await process.closeStdin().catch(() => undefined);
          throw error;
        } finally {
          writer.releaseLock();
        }
        const reader = process.stdout.getReader();
        let buffered = '';
        while (!buffered.includes('\n')) {
          const next = await reader.read();
          if (next.done) throw new Error('Workspace agent stream ended before metadata');
          buffered += next.value;
        }
        const newline = buffered.indexOf('\n');
        const metadata = z
          .object({
            statusCode: z.number().int().min(100).max(599),
            contentType: z.string().optional(),
          })
          .strict()
          .parse(JSON.parse(buffered.slice(0, newline)) as unknown);
        let remainder = buffered.slice(newline + 1);
        let cancelled = false;
        return {
          statusCode: metadata.statusCode,
          ...(metadata.contentType === undefined ? {} : { contentType: metadata.contentType }),
          body: {
            async *[Symbol.asyncIterator]() {
              if (remainder !== '') {
                yield Buffer.from(remainder);
                remainder = '';
              }
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                yield Buffer.from(next.value);
              }
              const exitCode = await process.wait();
              if (exitCode !== 0 && !cancelled) throw new Error('Workspace agent stream failed');
            },
          },
          async cancel() {
            cancelled = true;
            await reader.cancel();
          },
        };
      },
      async terminate() {
        await sandbox.terminate();
      },
    };
  }

  return {
    async createWorkspace(input) {
      const app = await client.apps.fromName(input.appName, {
        environment: input.environment,
        createIfMissing: true,
      });
      const image = await client.images.fromId(input.digest);
      const volume = await client.volumes.fromName(input.volume.name, {
        environment: input.environment,
        createIfMissing: true,
      });
      try {
        const sandbox = await client.sandboxes.create(app, image, {
          command: [...input.command],
          env: { ...input.environmentVariables },
          name: input.sandboxName,
          volumes: Object.fromEntries(
            input.volume.mounts.map(({ mountPath, subPath }) => [
              mountPath,
              volume.withMountOptions({ subPath }),
            ]),
          ),
          tags: { ...input.tags },
          cpu: input.resources.cpuRequest,
          cpuLimit: input.resources.cpuLimit,
          memoryMiB: input.resources.memRequestMiB,
          memoryLimitMiB: input.resources.memLimitMiB,
          encryptedPorts: [...input.encryptedPorts],
          readinessProbe: Probe.withTcp(input.readinessProbe.port, {
            intervalMs: input.readinessProbe.intervalMs,
          }),
          timeoutMs: input.timeoutMs,
          experimentalOptions: { vm_runtime: true },
        });
        return adapt(sandbox);
      } catch (error) {
        if (error instanceof AlreadyExistsError) {
          throw new BranchLockedError(input.tags.branch_id);
        }
        throw error;
      }
    },
    async getWorkspace(providerWorkspaceId) {
      try {
        const sandbox = await client.sandboxes.fromId(providerWorkspaceId);
        if ((await sandbox.poll()) !== null) return undefined;
        return adapt(sandbox);
      } catch (error) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
    },
    close() {
      client.close();
    },
  };
}

function workspaceEnvironmentVariables(
  callerEnvironment: Readonly<Record<string, string>>,
  agentToken: string,
  volume: ProjectVolumePlan,
): Readonly<Record<string, string>> {
  for (const name of Object.keys(callerEnvironment)) {
    if (!WORKSPACE_ENV_ALLOWLIST.has(name)) {
      throw new Error(`${name} environment variable is not allowlisted`);
    }
  }
  return {
    ZAPP_AGENT_TOKEN: agentToken,
    ZAPP_WORKSPACE_ROOT: volume.workspaceRoot,
    ...callerEnvironment,
    ...volume.environment,
  };
}

function workspaceBootCommand(
  volume: ProjectVolumePlan,
  seedPlaywrightCache: boolean,
): readonly string[] {
  const workspaceRoot = shellQuote(volume.workspaceRoot);
  const lockFile = shellQuote(volume.lockFile);
  const browserSeed = seedPlaywrightCache
    ? 'if [ ! -e /cache/ms-playwright ]; then ln -s /ms-playwright /cache/ms-playwright || test -L /cache/ms-playwright; fi; '
    : '';
  return [
    '/usr/bin/dumb-init',
    '--',
    '/bin/bash',
    '-lc',
    `set -euo pipefail; ${browserSeed}mkdir -p ${workspaceRoot}; exec 9>${lockFile}; flock -n 9 || exit 73; exec /opt/zapp/boot.sh`,
  ];
}

export class ModalSandboxProvider {
  readonly lockedImageTag: string;
  readonly attachmentEnvironment: ModalEnvironment;
  private readonly environment: WorkspaceEnvironmentName;
  private readonly modalEnvironment: ModalEnvironment;
  private readonly images: NonNullable<
    ModalImageLock['environments'][WorkspaceEnvironmentName]
  >['images'];
  private readonly agentToken: string;
  private readonly sdkFactory: (environment: ModalEnvironment) => ModalWorkspaceSdkPort;
  private readonly now: () => Date;
  private readonly clockMs: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: ModalSandboxProviderOptions) {
    this.environment = WorkspaceEnvironmentNameSchema.parse(options.environment);
    const lock = ModalImageLockSchema.parse(options.imageLock);
    const lockedEnvironment = lock.environments[this.environment];
    if (lockedEnvironment === undefined) {
      throw new Error(`No Modal image lock exists for ${this.environment}`);
    }
    this.modalEnvironment = lockedEnvironment.modalEnvironment;
    this.attachmentEnvironment = this.modalEnvironment;
    this.images = lockedEnvironment.images;
    this.lockedImageTag = this.images['forge-node-base'].publishedName;
    this.agentToken = z.string().min(1).parse(options.agentToken);
    this.now = options.now ?? (() => new Date());
    this.clockMs = options.clockMs ?? Date.now;
    this.sleep = options.sleep ?? delay;
    this.sdkFactory =
      options.sdkFactory ??
      ((environment) =>
        createModalWorkspaceSdk(options.credentials ?? credentialsFromEnvironment(), environment));
  }

  imageTagForPurpose(purpose: WorkspacePurpose): string {
    return purpose === 'verifier'
      ? this.images['forge-web-test'].publishedName
      : this.images['forge-node-base'].publishedName;
  }

  async createWorkspace(
    untrustedInput: CreateWorkspaceInput,
    onAllocated?: (providerWorkspaceId: string) => Promise<void>,
  ): Promise<WorkspaceHandle> {
    const input = CreateWorkspaceInputSchema.strict().parse(untrustedInput);
    const image =
      input.purpose === 'verifier'
        ? this.images['forge-web-test']
        : this.images['forge-node-base'];
    if (input.imageTag !== image.publishedName || input.imageTag.includes(':latest')) {
      throw new Error('Workspace image must match the immutable image lock');
    }
    const resources = RESOURCE_PROFILES[input.resourceProfile];
    const volume = createProjectVolumePlan({
      organizationId: input.organizationId,
      projectId: input.projectId,
      branchId: input.branchId,
    });
    const tags = SandboxTagsSchema.parse({
      org_id: input.organizationId,
      project_id: input.projectId,
      branch_id: input.branchId,
      run_id: input.runId ?? 'unattributed',
      task_id: input.taskId ?? 'unattributed',
      purpose: input.purpose,
      environment: this.modalEnvironment,
    });
    const sdk = this.sdkFactory(this.modalEnvironment);
    let sandbox: ModalWorkspaceSandbox | undefined;
    const sdkOwnership = { closeHere: true };
    const createdAt = this.now();
    const deadline = this.clockMs() + HEALTH_PROBE_TIMEOUT_MS;
    try {
      const creation = sdk.createWorkspace({
        environment: this.modalEnvironment,
        appName: this.images['forge-node-base'].appName,
        digest: image.digest,
        publishedName: image.publishedName,
        tags,
        resources: {
          cpuRequest: resources.cpuRequest,
          cpuLimit: resources.cpuLimit,
          memRequestMiB: resources.memRequestGiB * 1_024,
          memLimitMiB: resources.memLimitGiB * 1_024,
        },
        environmentVariables: workspaceEnvironmentVariables(input.env, this.agentToken, volume),
        sandboxName: volume.sandboxName,
        volume: { name: volume.volumeName, mounts: volume.mounts },
        command: workspaceBootCommand(volume, input.purpose === 'verifier'),
        encryptedPorts: [8877, 8080],
        readinessProbe: { kind: 'tcp', port: 8877, intervalMs: HEALTH_PROBE_INTERVAL_MS },
        timeoutMs: WORKSPACE_TIMEOUT_MS,
      });
      sandbox = await new Promise<ModalWorkspaceSandbox>((resolveCreation, rejectCreation) => {
        let settled = false;
        const timer = setTimeout(
          () => {
            if (settled) return;
            settled = true;
            sdkOwnership.closeHere = false;
            rejectCreation(new Error('Modal workspace creation exceeded the readiness deadline'));
            void creation.then(
              async (lateSandbox) => {
                try {
                  await lateSandbox.terminate();
                } finally {
                  sdk.close();
                }
              },
              () => {
                sdk.close();
              },
            );
          },
          Math.max(1, deadline - this.clockMs()),
        );
        void creation.then(
          (createdSandbox) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveCreation(createdSandbox);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectCreation(error instanceof Error ? error : new Error('Modal creation failed'));
          },
        );
      });
      await onAllocated?.(sandbox.providerWorkspaceId);
      if (this.clockMs() >= deadline) throw new Error('workspace agent readiness timed out');
      await sandbox.waitUntilReady(Math.max(1, deadline - this.clockMs()));
      for (;;) {
        if (this.clockMs() >= deadline) throw new Error('workspace agent readiness timed out');
        const health = WorkspaceAgentHealthSchema.parse(await sandbox.agentHealth(this.agentToken));
        if (this.clockMs() >= deadline) throw new Error('workspace agent readiness timed out');
        if (health.ok) break;
        await this.sleep(Math.min(HEALTH_PROBE_INTERVAL_MS, deadline - this.clockMs()));
      }
      return WorkspaceHandleSchema.parse({
        providerWorkspaceId: sandbox.providerWorkspaceId,
        status: 'ready',
        resourceProfile: input.resourceProfile,
        imageTag: image.publishedName,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + WORKSPACE_TIMEOUT_MS).toISOString(),
      });
    } catch (error) {
      if (sandbox !== undefined) {
        try {
          await sandbox.terminate();
        } catch {
          // The creation failure remains authoritative; the row never reports ready.
        }
      }
      throw error;
    } finally {
      if (sdkOwnership.closeHere) sdk.close();
    }
  }

  async attachWorkspace(
    providerWorkspaceId: string,
    untrustedAttachment: ModalWorkspaceAttachment,
  ): Promise<WorkspaceHandle> {
    const id = z.string().min(1).parse(providerWorkspaceId);
    const attachment = ModalWorkspaceAttachmentSchema.parse(untrustedAttachment);
    const sdk = this.sdkFactory(this.modalEnvironment);
    const deadline = this.clockMs() + HEALTH_PROBE_TIMEOUT_MS;
    try {
      const sandbox = await sdk.getWorkspace(id);
      if (sandbox === undefined) throw new ModalWorkspaceNotFoundError();
      let untrustedTags: unknown;
      try {
        untrustedTags = await sandbox.getTags();
      } catch (error) {
        if ((await sdk.getWorkspace(id)) === undefined) throw new ModalWorkspaceNotFoundError();
        throw error;
      }
      const tags = SandboxTagsSchema.parse(untrustedTags);
      const requiredTagNames = Object.keys(
        attachment.requiredTags,
      ) as Array<keyof SandboxTags>;
      if (requiredTagNames.some((name) => tags[name] !== attachment.requiredTags[name])) {
        throw new ModalWorkspaceTagMismatchError();
      }
      try {
        await sandbox.waitUntilReady(Math.max(1, deadline - this.clockMs()));
        for (;;) {
          if (this.clockMs() >= deadline) throw new Error('readiness deadline exceeded');
          const health = WorkspaceAgentHealthSchema.parse(await sandbox.agentHealth(this.agentToken));
          if (this.clockMs() >= deadline) throw new Error('readiness deadline exceeded');
          if (health.ok) break;
          await this.sleep(Math.min(HEALTH_PROBE_INTERVAL_MS, deadline - this.clockMs()));
        }
      } catch (error) {
        throw new ModalWorkspaceReadinessError({
          cause: error instanceof Error ? error : new Error('Unknown readiness failure'),
        });
      }
      return WorkspaceHandleSchema.parse({
        providerWorkspaceId: sandbox.providerWorkspaceId,
        status: 'ready',
        resourceProfile: attachment.resourceProfile,
        imageTag: attachment.imageTag,
        createdAt: attachment.createdAt.toISOString(),
        expiresAt: new Date(attachment.createdAt.getTime() + WORKSPACE_TIMEOUT_MS).toISOString(),
      });
    } finally {
      sdk.close();
    }
  }

  async resolvePreviewTunnel(providerWorkspaceId: string): Promise<URL> {
    const id = z.string().min(1).parse(providerWorkspaceId);
    const sdk = this.sdkFactory(this.modalEnvironment);
    try {
      const sandbox = await sdk.getWorkspace(id);
      if (sandbox === undefined) throw new ModalWorkspaceNotFoundError();
      const tunnel = (await sandbox.tunnels(HEALTH_PROBE_TIMEOUT_MS))[8080];
      if (tunnel === undefined) throw new Error('Workspace preview tunnel was not found');
      const url = new URL(tunnel.url);
      if (url.protocol !== 'https:') throw new Error('Workspace preview tunnel is not encrypted');
      return url;
    } finally {
      sdk.close();
    }
  }

  private async requestAgent(
    providerWorkspaceId: string,
    request: Omit<AgentHttpRequest, 'headers'> & {
      readonly idempotencyKey?: string;
      readonly contentType?: string;
    },
  ): Promise<AgentHttpResponse> {
    const id = z.string().min(1).parse(providerWorkspaceId);
    const sdk = this.sdkFactory(this.modalEnvironment);
    try {
      const sandbox = await sdk.getWorkspace(id);
      if (sandbox === undefined) throw new Error('Workspace sandbox was not found');
      return await sandbox.agentRequest({
        method: request.method,
        path: z.string().startsWith('/').parse(request.path),
        ...(request.query === undefined ? {} : { query: request.query }),
        headers: {
          authorization: `Bearer ${this.agentToken}`,
          ...(request.contentType === undefined ? {} : { 'content-type': request.contentType }),
          ...(request.idempotencyKey === undefined
            ? {}
            : { 'idempotency-key': request.idempotencyKey }),
        },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } finally {
      sdk.close();
    }
  }

  async exec(
    untrustedInput: ExecInput,
    idempotencyKey = randomUUID(),
  ): Promise<WorkspaceAgentExecResult> {
    const input = ExecInputSchema.strict().parse(untrustedInput);
    const body = z
      .object({
        cmd: z.string().min(1),
        args: z.array(z.string()),
        cwd: z.string().optional(),
        env: z.record(z.string()).optional(),
        timeoutMs: z.number().int().positive(),
        pty: z.boolean().optional(),
      })
      .strict()
      .parse({
        cmd: input.command,
        args: input.args,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.env === undefined ? {} : { env: input.env }),
        timeoutMs: input.timeoutMs,
        ...(input.pty === undefined ? {} : { pty: input.pty }),
      });
    const response = await this.requestAgent(input.providerWorkspaceId, {
      method: 'POST',
      path: '/exec',
      idempotencyKey,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(body)),
    });
    return WorkspaceAgentExecResultSchema.parse(jsonAgentBody(response));
  }

  async *execStream(
    untrustedInput: ExecInput,
    idempotencyKey = randomUUID(),
    signal?: AbortSignal,
  ): AsyncIterable<WorkspaceAgentStreamRecord> {
    const input = ExecInputSchema.strict().parse(untrustedInput);
    const body = {
      cmd: input.command,
      args: input.args,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.env === undefined ? {} : { env: input.env }),
      timeoutMs: input.timeoutMs,
      ...(input.pty === undefined ? {} : { pty: input.pty }),
    };
    const sdk = this.sdkFactory(this.modalEnvironment);
    let stream: AgentHttpStream | undefined;
    let abortStream: (() => void) | undefined;
    let active: Extract<WorkspaceAgentStreamRecord, { type: 'started' }> | undefined;
    let exited = false;
    const abortedRead = Symbol('aborted-agent-stream-read');
    let resolveAbortedRead: (() => void) | undefined;
    const abortedReadPromise = new Promise<typeof abortedRead>((resolve) => {
      resolveAbortedRead = () => {
        resolve(abortedRead);
      };
    });
    try {
      const sandbox = await sdk.getWorkspace(input.providerWorkspaceId);
      if (sandbox === undefined) throw new Error('Workspace sandbox was not found');
      stream = await sandbox.agentStream({
        method: 'POST',
        path: '/exec',
        query: { stream: '1' },
        headers: {
          authorization: `Bearer ${this.agentToken}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: Buffer.from(JSON.stringify(body)),
      });
      abortStream = () => {
        resolveAbortedRead?.();
        void stream?.cancel().catch(() => undefined);
      };
      if (signal?.aborted === true) abortStream();
      else if (signal !== undefined) signal.addEventListener('abort', abortStream, { once: true });
      if (stream.statusCode !== 200 || !stream.contentType?.startsWith('application/x-ndjson')) {
        throw new Error('Workspace agent returned an invalid execution stream');
      }
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const parsePendingRecords = function* (): Generator<WorkspaceAgentStreamRecord> {
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) return;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line !== '') {
            yield WorkspaceAgentStreamRecordSchema.parse(JSON.parse(line) as unknown);
          }
        }
      };
      const iterator = stream.body[Symbol.asyncIterator]();
      for (;;) {
        const nextRead = iterator.next();
        const next = await Promise.race([nextRead, abortedReadPromise]);
        if (next === abortedRead) {
          void nextRead.catch(() => undefined);
          break;
        }
        if (next.done) break;
        pending += decoder.write(Buffer.from(next.value));
        for (const record of parsePendingRecords()) {
          if (record.type === 'started') active = record;
          if (record.type === 'exit') exited = true;
          yield record;
        }
      }
      pending += decoder.end();
      for (const record of parsePendingRecords()) {
        if (record.type === 'started') active = record;
        if (record.type === 'exit') exited = true;
        yield record;
      }
      if (pending !== '') throw new Error('Workspace agent stream ended with a partial record');
      if (!exited && signal?.aborted !== true) {
        throw new Error('Workspace agent stream ended without an exit record');
      }
    } finally {
      if (signal !== undefined && abortStream !== undefined) {
        signal.removeEventListener('abort', abortStream);
      }
      try {
        if (active !== undefined && !exited) {
          await this.killExec(input.providerWorkspaceId, active.pid, active.executionId);
        }
      } finally {
        try {
          await stream?.cancel();
        } finally {
          sdk.close();
        }
      }
    }
  }

  async killExec(
    providerWorkspaceId: string,
    pid: number,
    executionId: string,
    idempotencyKey = randomUUID(),
  ) {
    const parsed = z
      .object({ pid: z.number().int().positive(), executionId: z.string().uuid() })
      .strict()
      .parse({ pid, executionId });
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'POST',
      path: `/exec/${String(parsed.pid)}/kill`,
      idempotencyKey,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ executionId: parsed.executionId })),
    });
    return KillResponseSchema.parse(jsonAgentBody(response));
  }

  async readFile(providerWorkspaceId: string, path: string): Promise<Uint8Array> {
    const parsedPath = z.string().min(1).parse(path);
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'GET',
      path: '/files',
      query: { path: parsedPath },
    });
    if (
      response.statusCode !== 200 ||
      !response.contentType?.startsWith('application/octet-stream')
    ) {
      throw new Error('Workspace agent returned an invalid file response');
    }
    return response.body;
  }

  async writeFile(
    providerWorkspaceId: string,
    path: string,
    data: Uint8Array,
    idempotencyKey = randomUUID(),
  ): Promise<void> {
    const input = z
      .object({ path: z.string().min(1), data: z.instanceof(Uint8Array) })
      .strict()
      .parse({ path, data });
    expectNoContent(
      await this.requestAgent(providerWorkspaceId, {
        method: 'PUT',
        path: '/files',
        query: { path: input.path },
        idempotencyKey,
        contentType: 'application/octet-stream',
        body: input.data,
      }),
    );
  }

  async listFiles(
    providerWorkspaceId: string,
    path: string,
    options: { readonly glob?: string; readonly maxDepth?: number } = {},
  ) {
    const input = z
      .object({
        path: z.string().min(1),
        glob: z.string().min(1).optional(),
        maxDepth: z.number().int().min(0).max(100).optional(),
      })
      .strict()
      .parse({ path, ...options });
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'GET',
      path: '/files/list',
      query: {
        path: input.path,
        ...(input.glob === undefined ? {} : { glob: input.glob }),
        ...(input.maxDepth === undefined ? {} : { maxDepth: String(input.maxDepth) }),
      },
    });
    return FileListSchema.parse(jsonAgentBody(response));
  }

  async git(providerWorkspaceId: string, untrustedInput: unknown, idempotencyKey = randomUUID()) {
    const input = GitInputSchema.parse(untrustedInput);
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'POST',
      path: '/git',
      idempotencyKey,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(input)),
    });
    return GitResultSchema.parse(jsonAgentBody(response));
  }

  async health(providerWorkspaceId: string) {
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'GET',
      path: '/healthz',
    });
    return HealthResponseSchema.parse(jsonAgentBody(response));
  }

  async metrics(providerWorkspaceId: string) {
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'GET',
      path: '/metrics',
    });
    return MetricsResponseSchema.parse(jsonAgentBody(response));
  }

  readFileForUpdate(providerWorkspaceId: string, path: string): Promise<never> {
    z.object({ providerWorkspaceId: z.string().min(1), path: z.string().min(1) })
      .strict()
      .parse({ providerWorkspaceId, path });
    return Promise.reject(new ModalAtomicWriteConflictError());
  }

  async writeFilesAtomically(
    providerWorkspaceId: string,
    untrustedFiles: readonly {
      readonly path: string;
      readonly data: Uint8Array;
      readonly expectedRevision?: string;
    }[],
    idempotencyKey = randomUUID(),
  ): Promise<void> {
    const files = z.array(AtomicFileWriteSchema).min(1).parse(untrustedFiles);
    if (files.some((file) => file.expectedRevision !== undefined)) {
      throw new ModalAtomicWriteConflictError();
    }
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'POST',
      path: '/files/atomic-write',
      idempotencyKey,
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          files: files.map((file) => ({
            path: file.path,
            dataBase64: Buffer.from(file.data).toString('base64'),
            ...(file.expectedRevision === undefined
              ? {}
              : { expectedRevision: file.expectedRevision }),
          })),
        }),
      ),
    });
    OkResponseSchema.parse(jsonAgentBodyWithConflict(response));
  }

  async search(providerWorkspaceId: string, untrustedInput: unknown) {
    const input = SearchInputSchema.parse(untrustedInput);
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'POST',
      path: '/search',
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(input)),
    });
    return WorkspaceAgentExecResultSchema.parse(jsonAgentBody(response));
  }

  async deleteFile(providerWorkspaceId: string, path: string, idempotencyKey = randomUUID()) {
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'DELETE',
      path: '/files',
      query: { path: z.string().min(1).parse(path) },
      idempotencyKey,
    });
    const parsed = DeleteResponseSchema.parse(jsonAgentBody(response));
    return { alreadyAbsent: parsed.alreadyAbsent };
  }

  async renameFile(
    providerWorkspaceId: string,
    untrustedInput: unknown,
    idempotencyKey = randomUUID(),
  ): Promise<void> {
    const input = RenameInputSchema.parse(untrustedInput);
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'POST',
      path: '/files/rename',
      idempotencyKey,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify(input)),
    });
    OkResponseSchema.parse(jsonAgentBody(response));
  }

  private async manageDevServer(
    providerWorkspaceId: string,
    action: 'start' | 'restart',
    untrustedContract: ExecutionContract,
    idempotencyKey: string,
  ) {
    const contract = ExecutionContractSchema.parse(untrustedContract);
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'POST',
      path: `/dev-server/${action}`,
      idempotencyKey,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ contract })),
    });
    const started = DevServerResponseSchema.parse(jsonAgentBody(response));
    const health = await this.health(providerWorkspaceId);
    if (
      !health.ok ||
      health.devServer === null ||
      !health.devServer.owned ||
      !health.devServer.httpReady ||
      health.devServer.port !== started.port ||
      health.devServer.pid !== started.pid ||
      health.devServer.supervisorId !== started.supervisorId
    ) {
      throw new Error('Workspace dev server readiness is not supervisor-owned');
    }
    return started;
  }

  async startDevServer(
    providerWorkspaceId: string,
    contract: ExecutionContract,
    idempotencyKey = randomUUID(),
  ) {
    return this.manageDevServer(providerWorkspaceId, 'start', contract, idempotencyKey);
  }

  async restartDevServer(
    providerWorkspaceId: string,
    contract: ExecutionContract,
    idempotencyKey = randomUUID(),
  ) {
    return this.manageDevServer(providerWorkspaceId, 'restart', contract, idempotencyKey);
  }

  async readDevServerLogs(providerWorkspaceId: string, untrustedQuery: unknown) {
    const query = DevServerLogsQuerySchema.parse(untrustedQuery);
    const response = await this.requestAgent(providerWorkspaceId, {
      method: 'GET',
      path: '/dev-server/logs',
      query: { after: String(query.after), limit: String(query.limit) },
    });
    return DevServerLogsResponseSchema.parse(jsonAgentBody(response));
  }

  async getStatus(providerWorkspaceId: string): Promise<WorkspaceStatus> {
    const id = z.string().min(1).parse(providerWorkspaceId);
    const sdk = this.sdkFactory(this.modalEnvironment);
    try {
      const sandbox = await sdk.getWorkspace(id);
      if (sandbox === undefined) return 'terminated';
      const health = WorkspaceAgentHealthSchema.parse(await sandbox.agentHealth(this.agentToken));
      return health.ok ? 'ready' : 'started';
    } finally {
      sdk.close();
    }
  }

  async terminateWorkspace(providerWorkspaceId: string): Promise<void> {
    const id = z.string().min(1).parse(providerWorkspaceId);
    const sdk = this.sdkFactory(this.modalEnvironment);
    try {
      const sandbox = await sdk.getWorkspace(id);
      if (sandbox === undefined) return;
      await sandbox.terminate();
      const deadline = this.clockMs() + HEALTH_PROBE_TIMEOUT_MS;
      while ((await sdk.getWorkspace(id)) !== undefined) {
        if (this.clockMs() >= deadline) {
          throw new Error('Modal sandbox termination was not confirmed');
        }
        await this.sleep(HEALTH_PROBE_INTERVAL_MS);
      }
    } finally {
      sdk.close();
    }
  }
}

export function createModalSandboxProvider(
  options: ModalSandboxProviderOptions,
): ModalSandboxProvider {
  return new ModalSandboxProvider(options);
}

export function createModalImagePublisher(
  options: ModalImagePublisherOptions = {},
): ModalImagePublisher {
  const sdkFactory =
    options.sdkFactory ??
    ((environment) =>
      createSdkPort(options.credentials ?? credentialsFromEnvironment(), environment));

  return {
    async publishImage(untrustedInput) {
      const input = PublishImageInputSchema.parse(untrustedInput);
      const sdk = sdkFactory(input.environment);
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
      const input = SmokeImageInputSchema.parse(untrustedInput);
      const sdk = sdkFactory(input.environment);
      try {
        return await runSmoke(sdk, input);
      } finally {
        sdk.close();
      }
    },

    async verifyPublishedImage(untrustedInput) {
      const input = VerifyPublishedImageInputSchema.parse(untrustedInput);
      const sdk = sdkFactory(input.environment);
      try {
        const resolved = await sdk.resolvePublishedImage({
          environment: input.environment,
          publishedName: input.publishedName,
        });
        if (resolved !== input.digest) {
          throw new Error('Published image name no longer resolves to the expected digest');
        }
      } finally {
        sdk.close();
      }
    },
  };
}
