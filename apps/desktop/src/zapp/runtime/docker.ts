import type { ExecutionContract, ExecInput } from "@zapp/contracts";
import type {
  AtomicFileWrite,
  ExecChunk,
  ExecResult,
  FileEntry,
  FileStat,
  GitOp,
  GitResult,
  WorkspaceFileSnapshot,
  WorkspaceRenameInput,
  WorkspaceRuntime,
  WorkspaceSearchInput,
} from "@zapp/workspace-runtime";
import { LocalWorkspaceRuntime } from "./local";

export const FORGE_NODE_BASE_IMAGE =
  "ghcr.io/crossbizz/zapp-forge-node-base:ws17-e4372846317b407634038de5a48af8c307b9ceca@sha256:6009a9369bf92d6735c937b86d1f112b6110248442cdb2f3f953fdd721bc6d69";
export const DOCKER_DIAGNOSTICS_URL =
  "https://docs.docker.com/desktop/troubleshoot/";

export interface DockerCommandRunner {
  run(args: readonly string[], timeoutMs: number): Promise<ExecResult>;
  stream(args: readonly string[], input: ExecInput): AsyncIterable<ExecChunk>;
}

function defaultRunner(root: string): DockerCommandRunner {
  const host = new LocalWorkspaceRuntime(root);
  return {
    run: async (args, timeoutMs) =>
      host.exec({ cmd: "docker", args: [...args], timeoutMs }),
    stream: (args, input) =>
      host.execStream({ ...input, command: "docker", args: [...args] }),
  };
}

export async function probeDockerAvailability(
  runner: DockerCommandRunner = defaultRunner(process.cwd()),
): Promise<{
  available: boolean;
  diagnosticsUrl: string;
  reason: string | null;
}> {
  const result = await runner.run(
    ["info", "--format", "{{.ServerVersion}}"],
    3_000,
  );
  return result.exitCode === 0
    ? { available: true, diagnosticsUrl: DOCKER_DIAGNOSTICS_URL, reason: null }
    : {
        available: false,
        diagnosticsUrl: DOCKER_DIAGNOSTICS_URL,
        reason: result.stderr.trim() || "Docker Desktop is unavailable",
      };
}

export class DockerWorkspaceRuntime implements WorkspaceRuntime {
  readonly kind = "docker" as const;
  private readonly local: LocalWorkspaceRuntime;
  private readonly runner: DockerCommandRunner;
  private readonly containerName: string;
  private ready: Promise<void> | undefined;

  constructor(
    readonly root: string,
    options: { runner?: DockerCommandRunner; containerName?: string } = {},
  ) {
    this.local = new LocalWorkspaceRuntime(root);
    this.runner = options.runner ?? defaultRunner(root);
    this.containerName = options.containerName ?? `zapp-desktop-${process.pid}`;
  }

  private async ensureContainer(): Promise<void> {
    this.ready ??= (async () => {
      const inspected = await this.runner.run(
        ["inspect", this.containerName],
        3_000,
      );
      if (inspected.exitCode === 0) return;
      const started = await this.runner.run(
        [
          "run",
          "-d",
          "--name",
          this.containerName,
          "--network",
          "host",
          "--mount",
          `type=bind,source=${this.root},target=/workspace`,
          "--workdir",
          "/workspace",
          "--entrypoint",
          "/bin/sh",
          FORGE_NODE_BASE_IMAGE,
          "-c",
          "trap 'exit 0' TERM INT; while :; do sleep 3600; done",
        ],
        30_000,
      );
      if (started.exitCode !== 0) {
        throw new Error(started.stderr || "Docker workspace failed to start");
      }
    })().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
  }

  private execArgs(input: {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  }): string[] {
    const env = Object.entries(input.env ?? {}).flatMap(([name, value]) => [
      "-e",
      `${name}=${value}`,
    ]);
    return [
      "exec",
      ...env,
      "-w",
      `/workspace/${input.cwd ?? "."}`,
      this.containerName,
      input.cmd,
      ...input.args,
    ];
  }

  async exec(
    input: Parameters<WorkspaceRuntime["exec"]>[0],
  ): Promise<ExecResult> {
    await this.ensureContainer();
    return this.runner.run(this.execArgs(input), input.timeoutMs);
  }

  async *execStream(input: ExecInput): AsyncIterable<ExecChunk> {
    await this.ensureContainer();
    yield* this.runner.stream(
      this.execArgs({
        cmd: input.command,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
      }),
      input,
    );
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.local.readFile(path);
  }
  readFileForUpdate(path: string): Promise<WorkspaceFileSnapshot> {
    return this.local.readFileForUpdate(path);
  }
  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.local.writeFile(path, data);
  }
  writeFilesAtomically(files: readonly AtomicFileWrite[]): Promise<void> {
    return this.local.writeFilesAtomically(files);
  }
  search(input: WorkspaceSearchInput): Promise<ExecResult> {
    return this.local.search(input);
  }
  listFiles(
    path: string,
    opts?: { glob?: string; maxDepth?: number },
  ): Promise<FileEntry[]> {
    return this.local.listFiles(path, opts);
  }
  stat(path: string): Promise<FileStat> {
    return this.local.stat(path);
  }
  delete(path: string): Promise<void> {
    return this.local.delete(path);
  }
  deleteFile(path: string): Promise<void> {
    return this.local.deleteFile(path);
  }
  renameFile(input: WorkspaceRenameInput): Promise<void> {
    return this.local.renameFile(input);
  }
  git(op: GitOp): Promise<GitResult> {
    return this.local.git(op);
  }

  async startDevServer(
    contract: ExecutionContract,
  ): Promise<{ port: number; pid: number }> {
    const result = await this.exec({
      cmd: "/bin/sh",
      args: [
        "-lc",
        `${contract.develop.command} >/tmp/zapp-dev.log 2>&1 & echo $!`,
      ],
      cwd: contract.workspace_root,
      timeoutMs: 5_000,
    });
    const pid = Number.parseInt(result.stdout.trim(), 10);
    if (result.exitCode !== 0 || !Number.isInteger(pid))
      throw new Error(result.stderr || "Development server failed to start");
    return { port: contract.develop.port, pid };
  }

  restartDevServer(
    contract: ExecutionContract,
  ): Promise<{ port: number; pid: number }> {
    return this.startDevServer(contract);
  }

  async health(): Promise<{ ok: boolean; details: string }> {
    const availability = await probeDockerAvailability(this.runner);
    return {
      ok: availability.available,
      details: availability.available
        ? `Docker workspace image ${FORGE_NODE_BASE_IMAGE}`
        : (availability.reason ?? "Docker unavailable"),
    };
  }
}
