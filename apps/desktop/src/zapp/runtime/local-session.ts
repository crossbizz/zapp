import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistry } from "@zapp/agent-tools";
import type { CompleteRequest } from "@zapp/model-gateway";
import {
  createSessionLoop,
  SessionTranscriptSchema,
  TranscriptConflictError,
  TranscriptKeySchema,
  type SessionEvent,
  type SessionGateway,
  type SessionTranscript,
  type SessionTranscriptDraft,
  type TranscriptStore,
} from "@zapp/orchestrator-worker/session";
import { resolveInRoot, type WorkspaceRuntime } from "@zapp/workspace-runtime";
import { z } from "zod";

import type { LocalWorkspaceRuntime } from "./local";

interface StoredTranscriptRow {
  readonly version: number;
  readonly transcript_json: string;
}

const ChangedPathsSchema = z.array(z.string().min(1).max(4_096)).max(10_000);
const GitRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const GitBranchRefSchema = z
  .string()
  .min("refs/heads/x".length)
  .max(1_024)
  .refine((value) => value.startsWith("refs/heads/"));
const ZERO_REVISION = "0000000000000000000000000000000000000000";
const EMPTY_TREE_REVISION = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CommitIntentSchema = z
  .object({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    intentId: z.string().regex(/^[a-f0-9]{64}$/u),
    baseRef: GitBranchRefSchema,
    baseRevision: GitRevisionSchema,
    paths: ChangedPathsSchema,
    message: z.string().min(1),
  })
  .strict();
type CommitIntent = z.infer<typeof CommitIntentSchema>;

interface StoredCommitIntentRow {
  readonly intent_id: string;
  readonly base_ref: string;
  readonly base_revision: string;
  readonly paths_json: string;
  readonly message: string;
}

export class SqliteTranscriptStore implements TranscriptStore {
  constructor(private readonly database: Database.Database) {}

  load(keyInput: unknown): Promise<SessionTranscript | undefined> {
    const key = TranscriptKeySchema.parse(keyInput);
    const row = this.database
      .prepare<[string, string], StoredTranscriptRow>(
        `SELECT version, transcript_json
           FROM zapp_local_agent_sessions
          WHERE run_id = ? AND task_id = ?`,
      )
      .get(key.runId, key.taskId);
    if (row === undefined) return Promise.resolve(undefined);
    const parsed = SessionTranscriptSchema.parse(
      JSON.parse(row.transcript_json) as unknown,
    );
    if (parsed.version !== row.version) {
      return Promise.reject(
        new Error("Local transcript row version does not match its payload"),
      );
    }
    return Promise.resolve(parsed);
  }

  save(
    expectedVersion: number | null,
    transcriptInput: unknown,
  ): Promise<SessionTranscript> {
    const draft = transcriptInput as SessionTranscriptDraft;
    const key = TranscriptKeySchema.parse(draft.key);
    const save = this.database.transaction((): SessionTranscript => {
      const current = this.database
        .prepare<[string, string], { readonly version: number }>(
          `SELECT version
             FROM zapp_local_agent_sessions
            WHERE run_id = ? AND task_id = ?`,
        )
        .get(key.runId, key.taskId);
      const actualVersion = current?.version ?? null;
      if (actualVersion !== expectedVersion)
        throw new TranscriptConflictError();
      const saved = SessionTranscriptSchema.parse({
        ...structuredClone(draft),
        version: (actualVersion ?? -1) + 1,
      });
      const serialized = JSON.stringify(saved);
      const updatedAt = Date.now();
      if (actualVersion === null) {
        this.database
          .prepare(
            `INSERT INTO zapp_local_agent_sessions
              (run_id, task_id, version, transcript_json, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(key.runId, key.taskId, saved.version, serialized, updatedAt);
      } else {
        const result = this.database
          .prepare(
            `UPDATE zapp_local_agent_sessions
                SET version = ?, transcript_json = ?, updated_at = ?
              WHERE run_id = ? AND task_id = ? AND version = ?`,
          )
          .run(
            saved.version,
            serialized,
            updatedAt,
            key.runId,
            key.taskId,
            actualVersion,
          );
        if (result.changes !== 1) throw new TranscriptConflictError();
      }
      return saved;
    });
    return Promise.resolve(save());
  }
}

class SqliteCommitIntentStore {
  constructor(private readonly database: Database.Database) {}

  load(runId: string, taskId: string): CommitIntent | undefined {
    const row = this.database
      .prepare<[string, string], StoredCommitIntentRow>(
        `SELECT intent_id, base_ref, base_revision, paths_json, message
           FROM zapp_local_agent_commit_intents
          WHERE run_id = ? AND task_id = ?`,
      )
      .get(runId, taskId);
    if (row === undefined) return undefined;
    return CommitIntentSchema.parse({
      runId,
      taskId,
      intentId: row.intent_id,
      baseRef: row.base_ref,
      baseRevision: row.base_revision,
      paths: JSON.parse(row.paths_json) as unknown,
      message: row.message,
    });
  }

  persist(intentInput: unknown): CommitIntent {
    const intent = CommitIntentSchema.parse(intentInput);
    this.database
      .prepare(
        `INSERT INTO zapp_local_agent_commit_intents
          (run_id, task_id, intent_id, base_ref, base_revision, paths_json, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, task_id) DO NOTHING`,
      )
      .run(
        intent.runId,
        intent.taskId,
        intent.intentId,
        intent.baseRef,
        intent.baseRevision,
        JSON.stringify(intent.paths),
        intent.message,
        Date.now(),
      );
    const stored = this.load(intent.runId, intent.taskId);
    if (stored === undefined || stored.intentId !== intent.intentId) {
      throw new Error("Local commit intent conflicts with durable state");
    }
    return stored;
  }

  clear(intent: CommitIntent): void {
    this.database
      .prepare(
        `DELETE FROM zapp_local_agent_commit_intents
          WHERE run_id = ? AND task_id = ? AND intent_id = ?`,
      )
      .run(intent.runId, intent.taskId, intent.intentId);
  }
}

export interface LocalAgentSessionOptions {
  readonly database: Database.Database;
  readonly gateway: SessionGateway;
  readonly tools: Pick<ToolRegistry, "get">;
  readonly runtime: WorkspaceRuntime & Pick<LocalWorkspaceRuntime, "root">;
  readonly prompts: Readonly<
    Record<"planner" | "builder" | "verifier" | "summarizer", string>
  >;
  readonly events?: { emit(event: SessionEvent): void | Promise<void> };
  readonly approvals?: {
    status():
      | "pending"
      | "approved"
      | "denied"
      | Promise<"pending" | "approved" | "denied">;
  };
  readonly redact: (value: string) => string;
  readonly countRequestTokens?: (request: CompleteRequest) => number;
}

function conservativeTokenCount(request: CompleteRequest): number {
  return Math.ceil(
    Buffer.byteLength(JSON.stringify(request.messages), "utf8") / 3,
  );
}

function changedPaths(transcript: SessionTranscript): string[] {
  return [...new Set(ChangedPathsSchema.parse(transcript.changedPaths))].sort();
}

function createCommitIntent(
  runId: string,
  taskId: string,
  transcriptVersion: number,
  paths: readonly string[],
  base: { readonly ref: string; readonly revision: string },
): CommitIntent {
  const intentId = createHash("sha256")
    .update(JSON.stringify({ runId, taskId, transcriptVersion, paths, base }))
    .digest("hex");
  return CommitIntentSchema.parse({
    runId,
    taskId,
    intentId,
    baseRef: base.ref,
    baseRevision: base.revision,
    paths,
    message: `zapp local agent ${runId}\n\nzapp-local-intent:${intentId}`,
  });
}

async function captureCommitBase(
  runtime: WorkspaceRuntime,
): Promise<{ readonly ref: string; readonly revision: string }> {
  const ref = await runtime.exec({
    cmd: "git",
    args: ["-c", "core.fsmonitor=false", "symbolic-ref", "--quiet", "HEAD"],
    timeoutMs: 30_000,
  });
  if (ref.exitCode !== 0) {
    throw new Error("Local session commits require an attached branch");
  }
  const parsedRef = GitBranchRefSchema.parse(ref.stdout.trim());
  const revision = await runtime.exec({
    cmd: "git",
    args: [
      "-c",
      "core.fsmonitor=false",
      "rev-parse",
      "--verify",
      `${parsedRef}^{commit}`,
    ],
    timeoutMs: 30_000,
  });
  if (revision.exitCode === 0) {
    return {
      ref: parsedRef,
      revision: GitRevisionSchema.parse(revision.stdout.trim()),
    };
  }
  const existing = await runtime.exec({
    cmd: "git",
    args: [
      "-c",
      "core.fsmonitor=false",
      "show-ref",
      "--verify",
      "--quiet",
      parsedRef,
    ],
    timeoutMs: 30_000,
  });
  if (existing.exitCode !== 1) {
    throw new Error("Could not resolve the local branch revision");
  }
  return { ref: parsedRef, revision: ZERO_REVISION };
}

async function findIntentCommit(
  runtime: WorkspaceRuntime,
  intent: CommitIntent,
): Promise<string | undefined> {
  const result = await runtime.exec({
    cmd: "git",
    args: [
      "-c",
      "core.fsmonitor=false",
      "log",
      "--all",
      "--format=%H",
      "--fixed-strings",
      `--grep=zapp-local-intent:${intent.intentId}`,
      "-n",
      "1",
    ],
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error("Could not reconcile the local commit intent");
  }
  const commit = result.stdout.trim();
  if (commit.length === 0) return undefined;
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Local commit intent resolved to an invalid revision");
  }
  return commit;
}

class LocalCommitRefConflictError extends Error {
  constructor() {
    super("Local agent commit reference conflicts with durable state");
    this.name = "LocalCommitRefConflictError";
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function checkedGit(
  runtime: WorkspaceRuntime,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  const result = await runtime.exec({
    cmd: "git",
    args: ["-c", "core.fsmonitor=false", ...args],
    env,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error("Could not commit local session changes");
  }
  return result.stdout;
}

async function treeEntry(
  runtime: WorkspaceRuntime,
  revision: string,
  path: string,
): Promise<{ readonly mode: string; readonly objectId: string } | undefined> {
  if (revision === ZERO_REVISION) return undefined;
  const output = await checkedGit(runtime, [
    "ls-tree",
    "-z",
    revision,
    "--",
    path,
  ]);
  const match = /^(\d+)\s+blob\s+([a-f0-9]{40})\t[^\0]+\0$/u.exec(output);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { mode: match[1], objectId: match[2] };
}

async function synchronizePrimaryIndex(
  runtime: WorkspaceRuntime & Pick<LocalWorkspaceRuntime, "root">,
  intent: CommitIntent,
  commit: string,
): Promise<void> {
  const currentRef = await checkedGit(runtime, [
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ]);
  const currentRevision = await checkedGit(runtime, [
    "rev-parse",
    "--verify",
    `${intent.baseRef}^{commit}`,
  ]);
  if (
    currentRef.trim() !== intent.baseRef ||
    currentRevision.trim() !== commit
  ) {
    throw new LocalCommitRefConflictError();
  }

  const gitDirectory = (
    await checkedGit(runtime, ["rev-parse", "--absolute-git-dir"])
  ).trim();
  const primaryIndex = join(gitDirectory, "index");
  const indexLock = `${primaryIndex}.lock`;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zapp-local-index-"));
  const preparedIndex = join(temporaryDirectory, "index");
  let ownsLock = false;
  try {
    const lock = await open(indexLock, "wx", 0o600);
    await lock.close();
    ownsLock = true;
    try {
      await copyFile(primaryIndex, preparedIndex);
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
      await checkedGit(runtime, ["read-tree", "--empty"], {
        GIT_INDEX_FILE: preparedIndex,
      });
    }

    for (const path of intent.paths) {
      const entry = await treeEntry(runtime, commit, path);
      if (entry === undefined) {
        const removal = await runtime.exec({
          cmd: "git",
          args: [
            "-c",
            "core.fsmonitor=false",
            "update-index",
            "--force-remove",
            "--",
            path,
          ],
          env: { GIT_INDEX_FILE: preparedIndex },
          timeoutMs: 30_000,
        });
        if (removal.exitCode !== 0) {
          throw new Error("Could not reconcile the local Git index");
        }
      } else {
        await checkedGit(
          runtime,
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `${entry.mode},${entry.objectId},${path}`,
          ],
          { GIT_INDEX_FILE: preparedIndex },
        );
      }
    }

    const lockedRef = await checkedGit(runtime, [
      "symbolic-ref",
      "--quiet",
      "HEAD",
    ]);
    const lockedRevision = await checkedGit(runtime, [
      "rev-parse",
      "--verify",
      `${intent.baseRef}^{commit}`,
    ]);
    if (
      lockedRef.trim() !== intent.baseRef ||
      lockedRevision.trim() !== commit
    ) {
      throw new LocalCommitRefConflictError();
    }
    await copyFile(preparedIndex, indexLock);
    await rename(indexLock, primaryIndex);
    ownsLock = false;
  } finally {
    if (ownsLock) await rm(indexLock, { force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function commitExactPaths(
  runtime: WorkspaceRuntime & Pick<LocalWorkspaceRuntime, "root">,
  intent: CommitIntent,
): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "zapp-local-commit-"));
  const index = join(directory, "index");
  try {
    await checkedGit(
      runtime,
      intent.baseRevision === ZERO_REVISION
        ? ["read-tree", "--empty"]
        : ["read-tree", intent.baseRevision],
      { GIT_INDEX_FILE: index },
    );
    let materialPath = false;
    for (const path of intent.paths) {
      let data: Uint8Array | undefined;
      try {
        data = await runtime.readFile(path);
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
      if (data === undefined) {
        if (
          (await treeEntry(runtime, intent.baseRevision, path)) !== undefined
        ) {
          materialPath = true;
          const removal = await runtime.exec({
            cmd: "git",
            args: [
              "-c",
              "core.fsmonitor=false",
              "update-index",
              "--force-remove",
              "--",
              path,
            ],
            env: { GIT_INDEX_FILE: index },
            timeoutMs: 30_000,
          });
          if (removal.exitCode !== 0) {
            throw new Error("Could not prepare local session changes");
          }
        }
        continue;
      }
      materialPath = true;
      const objectId = (
        await checkedGit(runtime, [
          "hash-object",
          "-w",
          "--no-filters",
          "--",
          path,
        ])
      ).trim();
      const metadata = await lstat(await resolveInRoot(runtime.root, path));
      const mode = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
      await checkedGit(
        runtime,
        ["update-index", "--add", "--cacheinfo", `${mode},${objectId},${path}`],
        { GIT_INDEX_FILE: index },
      );
    }
    if (!materialPath) return undefined;
    const tree = (
      await checkedGit(runtime, ["write-tree"], { GIT_INDEX_FILE: index })
    ).trim();
    const baseTree =
      intent.baseRevision === ZERO_REVISION
        ? EMPTY_TREE_REVISION
        : (
            await checkedGit(runtime, [
              "rev-parse",
              "--verify",
              `${intent.baseRevision}^{tree}`,
            ])
          ).trim();
    if (tree === baseTree) return undefined;
    const commitArgs = [
      "-c",
      `core.hooksPath=${directory}`,
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      tree,
    ];
    if (intent.baseRevision !== ZERO_REVISION) {
      commitArgs.push("-p", intent.baseRevision);
    }
    commitArgs.push("-m", intent.message);
    const commitResult = await runtime.exec({
      cmd: "git",
      args: commitArgs,
      env: {
        GIT_AUTHOR_NAME: "zapp local agent",
        GIT_AUTHOR_EMAIL: "local-agent@zapp.build",
        GIT_COMMITTER_NAME: "zapp local agent",
        GIT_COMMITTER_EMAIL: "local-agent@zapp.build",
      },
      timeoutMs: 30_000,
    });
    if (commitResult.exitCode !== 0) {
      throw new Error("Could not create the local session commit");
    }
    const commit = GitRevisionSchema.parse(commitResult.stdout.trim());
    const update = await runtime.exec({
      cmd: "git",
      args: [
        "-c",
        `core.hooksPath=${directory}`,
        "-c",
        "core.fsmonitor=false",
        "update-ref",
        intent.baseRef,
        commit,
        intent.baseRevision,
      ],
      env: {
        ZAPP_EXPECTED_REF: intent.baseRef,
        ZAPP_EXPECTED_REVISION: intent.baseRevision,
      },
      timeoutMs: 30_000,
    });
    if (update.exitCode !== 0) {
      throw new LocalCommitRefConflictError();
    }
    await synchronizePrimaryIndex(runtime, intent, commit);
    return commit;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function reconcileCommitIntent(input: {
  readonly transcripts: SqliteTranscriptStore;
  readonly intents: SqliteCommitIntentStore;
  readonly runtime: WorkspaceRuntime & Pick<LocalWorkspaceRuntime, "root">;
  readonly intent: CommitIntent;
}): Promise<string | undefined> {
  let commit = await findIntentCommit(input.runtime, input.intent);
  if (commit === undefined) {
    try {
      commit = await commitExactPaths(input.runtime, input.intent);
    } catch (error) {
      if (error instanceof LocalCommitRefConflictError) {
        input.intents.clear(input.intent);
      }
      throw error;
    }
  } else {
    await synchronizePrimaryIndex(input.runtime, input.intent, commit);
  }
  if (commit === undefined) {
    input.intents.clear(input.intent);
    return undefined;
  }
  const current = await input.transcripts.load({
    runId: input.intent.runId,
    taskId: input.intent.taskId,
  });
  if (current === undefined) {
    throw new Error("Committed local session transcript is missing");
  }
  if (!current.commits.includes(commit)) {
    await input.transcripts.save(current.version, {
      ...current,
      commits: [...current.commits, commit],
    });
  }
  input.intents.clear(input.intent);
  return commit;
}

/** Builds the packaged AR-6 loop over the desktop's durable SQLite database. */
export function createLocalAgentSession(options: LocalAgentSessionOptions) {
  if (typeof options.redact !== "function") {
    throw new Error("Local agent session requires a redactor");
  }
  const transcripts = new SqliteTranscriptStore(options.database);
  const intents = new SqliteCommitIntentStore(options.database);
  const session = createSessionLoop({
    gateway: options.gateway,
    tools: options.tools,
    transcripts,
    events: options.events ?? { emit: () => undefined },
    approvals: options.approvals ?? { status: () => "pending" },
    prompts: options.prompts,
    redact: options.redact,
    countRequestTokens: options.countRequestTokens ?? conservativeTokenCount,
  });

  const commitTerminalChanges = async (
    runId: string,
    taskId: string,
  ): Promise<void> => {
    let transcript = await transcripts.load({ runId, taskId });
    if (transcript === undefined) {
      throw new Error("Terminal local session transcript is missing");
    }
    const pendingIntent = intents.load(runId, taskId);
    if (pendingIntent !== undefined) {
      await reconcileCommitIntent({
        transcripts,
        intents,
        runtime: options.runtime,
        intent: pendingIntent,
      });
      transcript = (await transcripts.load({ runId, taskId })) ?? transcript;
    }
    const orderedPaths = changedPaths(transcript);
    if (orderedPaths.length === 0) return;
    const intent = intents.persist(
      createCommitIntent(
        runId,
        taskId,
        transcript.version,
        orderedPaths,
        await captureCommitBase(options.runtime),
      ),
    );
    await reconcileCommitIntent({
      transcripts,
      intents,
      runtime: options.runtime,
      intent,
    });
  };

  return {
    async run(
      input: Parameters<typeof session.run>[0],
      signal?: AbortSignal,
    ): ReturnType<typeof session.run> {
      const taskId = input.taskId ?? input.context.taskId;
      let existingTranscript = await transcripts.load({
        runId: input.runId,
        taskId,
      });
      const previousCommits = new Set(existingTranscript?.commits ?? []);
      const redirect = input.control?.redirect;
      if (
        existingTranscript?.terminalStatus !== null &&
        existingTranscript?.terminalStatus !== undefined &&
        redirect !== null &&
        redirect !== undefined &&
        !existingTranscript.appliedRedirectOperationKeys.includes(
          redirect.operationKey,
        )
      ) {
        await commitTerminalChanges(input.runId, taskId);
        existingTranscript = await transcripts.load({
          runId: input.runId,
          taskId,
        });
        if (existingTranscript === undefined) {
          throw new Error("Terminal local session transcript is missing");
        }
        const { version, ...draft } = existingTranscript;
        const budgets = {
          ...input.budgets,
          maxTurns: existingTranscript.turns + input.budgets.maxTurns,
        };
        existingTranscript = await transcripts.save(version, {
          ...draft,
          role: input.role,
          mode: input.mode,
          tools: input.tools,
          budgets,
          startedAtMs: Date.now(),
          provenance: [],
          messages: [
            {
              role: "system",
              content: [options.prompts[input.role], input.modeInstructions]
                .filter((part): part is string => part !== undefined)
                .join("\n\n"),
            },
          ],
          tokensUsed: 0,
          inFlightCompletion: null,
          completedToolCallIds: [],
          completedToolNames: [],
          successfulToolNames: [],
          prototypeMocks: [],
          pendingToolCalls: [],
          activeToolCallId: null,
          executionLease: null,
          changedPaths: [],
          summary: "",
          terminalStatus: null,
          terminalErrorCode: null,
        });
      }
      const effectiveInput =
        existingTranscript === undefined
          ? input
          : { ...input, budgets: existingTranscript.budgets };
      const result = await session.run(effectiveInput, signal);
      if (
        result.status === "completed" ||
        result.status === "failed" ||
        result.status === "cancelled" ||
        result.status === "budget_exhausted"
      ) {
        await commitTerminalChanges(input.runId, taskId);
      }
      const transcript = await transcripts.load({ runId: input.runId, taskId });
      if (transcript === undefined) return result;
      return {
        ...result,
        commits: [
          ...new Set([...result.commits, ...transcript.commits]),
        ].filter((candidate) => !previousCommits.has(candidate)),
      };
    },
  };
}
