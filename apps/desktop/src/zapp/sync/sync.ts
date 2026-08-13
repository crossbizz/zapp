export interface RepositoryLease {
  readonly cloneUrl: string;
  readonly expiresAt: string;
  readonly token: string;
  readonly username: string;
}

export interface RepositoryLeasePort {
  acquire(projectId: string): Promise<RepositoryLease>;
}

export interface GitSyncPort {
  dirtyFiles(): Promise<readonly string[]>;
  commitAll(message: string): Promise<void>;
  stash(): Promise<void>;
  discard(): Promise<void>;
  fetch(lease: RepositoryLease): Promise<void>;
  localHead(): Promise<string>;
  remoteHead(): Promise<string>;
  mergeBase(localHead: string, remoteHead: string): Promise<string>;
  fastForward(remoteHead: string): Promise<void>;
  push(lease: RepositoryLease): Promise<void>;
  beginMerge(remoteHead: string): Promise<readonly string[]>;
  completeMerge(
    resolvedFiles: readonly string[],
    expectedLocalParent: string,
    expectedRemoteParent: string,
  ): Promise<string>;
}

export type DirtyChoice = "commit" | "discard" | "stash";

export type SyncResult =
  | {
      readonly state: "dirty";
      readonly files: readonly string[];
      readonly actions: readonly DirtyChoice[];
    }
  | {
      readonly state: "conflicts";
      readonly files: readonly string[];
      readonly localHead: string;
      readonly remoteHead: string;
    }
  | {
      readonly state: "synchronized";
      readonly action: "already_current" | "fast_forward" | "merge" | "push";
      readonly head: string;
    };

export class CommitSync {
  private divergence:
    | { readonly localHead: string; readonly remoteHead: string }
    | undefined;

  constructor(
    private readonly projectId: string,
    private readonly git: GitSyncPort,
    private readonly leases: RepositoryLeasePort,
  ) {}

  async synchronize(
    options: { dirtyChoice?: DirtyChoice } = {},
  ): Promise<SyncResult> {
    const dirty = await this.git.dirtyFiles();
    if (dirty.length > 0 && options.dirtyChoice === undefined) {
      return {
        state: "dirty",
        files: dirty,
        actions: ["commit", "stash", "discard"],
      };
    }
    if (dirty.length > 0) {
      if (options.dirtyChoice === "commit")
        await this.git.commitAll("Sync local changes");
      if (options.dirtyChoice === "stash") await this.git.stash();
      if (options.dirtyChoice === "discard") await this.git.discard();
    }

    const lease = await this.leases.acquire(this.projectId);
    await this.git.fetch(lease);
    const [localHead, remoteHead] = await Promise.all([
      this.git.localHead(),
      this.git.remoteHead(),
    ]);
    if (localHead === remoteHead) {
      return {
        state: "synchronized",
        action: "already_current",
        head: localHead,
      };
    }
    const base = await this.git.mergeBase(localHead, remoteHead);
    if (base === localHead) {
      await this.git.fastForward(remoteHead);
      return {
        state: "synchronized",
        action: "fast_forward",
        head: remoteHead,
      };
    }
    if (base === remoteHead) {
      await this.git.push(lease);
      return { state: "synchronized", action: "push", head: localHead };
    }

    const files = await this.git.beginMerge(remoteHead);
    this.divergence = { localHead, remoteHead };
    return { state: "conflicts", files, localHead, remoteHead };
  }

  async completeMerge(resolvedFiles: readonly string[]): Promise<SyncResult> {
    const divergence = this.divergence;
    if (divergence === undefined) throw new Error("No guided merge is active");
    const head = await this.git.completeMerge(
      resolvedFiles,
      divergence.localHead,
      divergence.remoteHead,
    );
    const lease = await this.leases.acquire(this.projectId);
    await this.git.push(lease);
    this.divergence = undefined;
    return { state: "synchronized", action: "merge", head };
  }
}

export function ephemeralGitAuth(lease: RepositoryLease): {
  readonly remote: string;
  readonly environment: Readonly<Record<string, string>>;
} {
  const credentials = Buffer.from(
    `${lease.username}:${lease.token}`,
    "utf8",
  ).toString("base64");
  return {
    remote: lease.cloneUrl,
    environment: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
    },
  };
}

export interface GitCommandRuntime {
  exec(input: {
    cmd: string;
    args: string[];
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class LocalGitSyncPort implements GitSyncPort {
  constructor(private readonly runtime: GitCommandRuntime) {}

  private async command(
    args: string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<string> {
    const result = await this.runtime.exec({
      cmd: "git",
      args,
      ...(environment === undefined ? {} : { env: { ...environment } }),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr || `git ${args[0] ?? "command"} failed`);
    return result.stdout.trim();
  }

  async dirtyFiles(): Promise<readonly string[]> {
    const output = await this.command(["status", "--porcelain"]);
    return output === "" ? [] : output.split("\n").map((line) => line.slice(3));
  }
  async commitAll(message: string): Promise<void> {
    await this.command(["add", "--all"]);
    await this.command(["commit", "-m", message]);
  }
  async stash(): Promise<void> {
    await this.command(["stash", "push", "--include-untracked"]);
  }
  async discard(): Promise<void> {
    await this.command(["reset", "--hard", "HEAD"]);
    await this.command(["clean", "-fd"]);
  }
  async fetch(lease: RepositoryLease): Promise<void> {
    const auth = ephemeralGitAuth(lease);
    await this.command(
      ["fetch", "--no-tags", auth.remote, "+HEAD:refs/remotes/zapp/cloud"],
      auth.environment,
    );
  }
  localHead(): Promise<string> {
    return this.command(["rev-parse", "HEAD"]);
  }
  remoteHead(): Promise<string> {
    return this.command(["rev-parse", "refs/remotes/zapp/cloud"]);
  }
  mergeBase(localHead: string, remoteHead: string): Promise<string> {
    return this.command(["merge-base", localHead, remoteHead]);
  }
  async fastForward(remoteHead: string): Promise<void> {
    await this.command(["merge", "--ff-only", remoteHead]);
  }
  async push(lease: RepositoryLease): Promise<void> {
    const auth = ephemeralGitAuth(lease);
    await this.command(["push", auth.remote, "HEAD"], auth.environment);
  }
  async beginMerge(remoteHead: string): Promise<readonly string[]> {
    const result = await this.runtime.exec({
      cmd: "git",
      args: ["merge", "--no-commit", "--no-ff", remoteHead],
      timeoutMs: 30_000,
    });
    if (result.exitCode === 0) return [];
    const conflicts = await this.command([
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    if (conflicts === "") throw new Error(result.stderr || "git merge failed");
    return conflicts.split("\n");
  }
  async completeMerge(
    resolvedFiles: readonly string[],
    expectedLocalParent: string,
    expectedRemoteParent: string,
  ): Promise<string> {
    const [head, mergeHead] = await Promise.all([
      this.command(["rev-parse", "HEAD"]),
      this.command(["rev-parse", "MERGE_HEAD"]),
    ]);
    if (head !== expectedLocalParent || mergeHead !== expectedRemoteParent) {
      throw new Error("Merge parents changed; restart guided merge");
    }
    await this.command(["add", "--", ...resolvedFiles]);
    await this.command(["commit", "-m", "Merge cloud changes"]);
    return this.command(["rev-parse", "HEAD"]);
  }
}
