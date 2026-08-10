import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type { WorkspaceRuntime } from "@zapp/workspace-runtime";
import { z } from "zod";

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
  readonly runtime: WorkspaceRuntime;
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
    args: ["symbolic-ref", "--quiet", "HEAD"],
    timeoutMs: 30_000,
  });
  if (ref.exitCode !== 0) {
    throw new Error("Local session commits require an attached branch");
  }
  const parsedRef = GitBranchRefSchema.parse(ref.stdout.trim());
  const revision = await runtime.exec({
    cmd: "git",
    args: ["rev-parse", "--verify", `${parsedRef}^{commit}`],
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
    args: ["show-ref", "--verify", "--quiet", parsedRef],
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

async function commitExactPaths(
  runtime: WorkspaceRuntime,
  intent: CommitIntent,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zapp-local-hooks-"));
  try {
    const relevantPaths: string[] = [];
    for (const path of intent.paths) {
      let existsInWorkspace = true;
      try {
        await runtime.readFile(path);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "ENOENT" && error.code !== "ENOTDIR")
        ) {
          throw error;
        }
        existsInWorkspace = false;
      }
      let existsAtBase = false;
      if (!existsInWorkspace && intent.baseRevision !== ZERO_REVISION) {
        const tracked = await runtime.exec({
          cmd: "git",
          args: ["ls-tree", "--name-only", intent.baseRevision, "--", path],
          timeoutMs: 30_000,
        });
        if (tracked.exitCode !== 0) {
          throw new Error("Could not commit local session changes");
        }
        existsAtBase = tracked.stdout.split("\n").includes(path);
      }
      if (existsInWorkspace || existsAtBase) relevantPaths.push(path);
    }
    if (relevantPaths.length === 0) {
      throw new Error("Local commit intent has no material paths");
    }
    const intentToAdd = await runtime.exec({
      cmd: "git",
      args: ["add", "--intent-to-add", "-A", "--", ...relevantPaths],
      timeoutMs: 30_000,
    });
    if (intentToAdd.exitCode !== 0) {
      throw new Error("Could not prepare local session changes");
    }
    const hook = join(directory, "pre-commit");
    await writeFile(
      hook,
      `#!/bin/sh
current_ref=$(git symbolic-ref --quiet HEAD) || exit 1
test "$current_ref" = "$ZAPP_EXPECTED_REF" || exit 1
if test "$ZAPP_EXPECTED_REVISION" = "${ZERO_REVISION}"; then
  git show-ref --verify --quiet "$current_ref" && exit 1
else
  current_revision=$(git rev-parse --verify "$current_ref^{commit}") || exit 1
  test "$current_revision" = "$ZAPP_EXPECTED_REVISION" || exit 1
fi
`,
      { encoding: "utf8", mode: 0o700 },
    );
    await chmod(hook, 0o700);
    const commit = await runtime.exec({
      cmd: "git",
      args: [
        "-c",
        `core.hooksPath=${directory}`,
        "commit",
        "--only",
        "-m",
        intent.message,
        "--",
        ...relevantPaths,
      ],
      env: {
        ZAPP_EXPECTED_REF: intent.baseRef,
        ZAPP_EXPECTED_REVISION: intent.baseRevision,
      },
      timeoutMs: 30_000,
    });
    if (commit.exitCode !== 0) {
      throw new LocalCommitRefConflictError();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function reconcileCommitIntent(input: {
  readonly transcripts: SqliteTranscriptStore;
  readonly intents: SqliteCommitIntentStore;
  readonly runtime: WorkspaceRuntime;
  readonly intent: CommitIntent;
}): Promise<string> {
  let commit = await findIntentCommit(input.runtime, input.intent);
  if (commit === undefined) {
    const status = await input.runtime.git({
      operation: "status",
      args: ["--short", "--", ...input.intent.paths],
    });
    if (status.exitCode !== 0 || status.stdout.trim().length === 0) {
      throw new Error("Local commit intent has neither changes nor a commit");
    }
    try {
      await commitExactPaths(input.runtime, input.intent);
    } catch (error) {
      if (error instanceof LocalCommitRefConflictError) {
        input.intents.clear(input.intent);
      }
      throw error;
    }
    commit = await findIntentCommit(input.runtime, input.intent);
    if (commit === undefined) {
      throw new Error(
        "Committed local session revision could not be reconciled",
      );
    }
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
  return {
    async run(
      input: Parameters<typeof session.run>[0],
      signal?: AbortSignal,
    ): ReturnType<typeof session.run> {
      const taskId = input.taskId ?? input.context.taskId;
      let existingTranscript = await transcripts.load({ runId: input.runId, taskId });
      const previousCommits = new Set(existingTranscript?.commits ?? []);
      const redirect = input.control?.redirect;
      if (
        existingTranscript?.terminalStatus === "completed" &&
        redirect !== null &&
        redirect !== undefined &&
        !existingTranscript.appliedRedirectOperationKeys.includes(
          redirect.operationKey,
        )
      ) {
        const { version, ...draft } = existingTranscript;
        existingTranscript = await transcripts.save(version, {
          ...draft,
          role: input.role,
          mode: input.mode,
          tools: input.tools,
          budgets: input.budgets,
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
          completedToolCallIds: [],
          completedToolNames: [],
          successfulToolNames: [],
          prototypeMocks: [],
        });
      }
      const effectiveInput =
        existingTranscript === undefined && input.control?.redirect !== null
          ? {
              ...input,
              control: {
                ...(input.control ?? { yieldAfterTool: false }),
                redirect: null,
              },
            }
          : input;
      const result = await session.run(effectiveInput, signal);
      if (result.status !== "completed") return result;
      let transcript = await transcripts.load({ runId: input.runId, taskId });
      if (transcript === undefined)
        throw new Error("Completed local session transcript is missing");
      let commit: string | undefined;
      const pendingIntent = intents.load(input.runId, taskId);
      if (pendingIntent !== undefined) {
        commit = await reconcileCommitIntent({
          transcripts,
          intents,
          runtime: options.runtime,
          intent: pendingIntent,
        });
        transcript =
          (await transcripts.load({ runId: input.runId, taskId })) ??
          transcript;
      }
      const orderedPaths = changedPaths(transcript);
      if (orderedPaths.length === 0) {
        return {
          ...result,
          commits: [...new Set([...result.commits, ...transcript.commits])].filter(
            (candidate) => !previousCommits.has(candidate),
          ),
        };
      }
      const status = await options.runtime.git({
        operation: "status",
        args: ["--short", "--", ...orderedPaths],
      });
      if (status.exitCode !== 0)
        throw new Error("Could not inspect local session changes");
      if (status.stdout.trim().length === 0) {
        return {
          ...result,
          commits: [...new Set([...result.commits, ...transcript.commits])].filter(
            (candidate) => !previousCommits.has(candidate),
          ),
        };
      }
      const intent = intents.persist(
        createCommitIntent(
          input.runId,
          taskId,
          transcript.version,
          orderedPaths,
          await captureCommitBase(options.runtime),
        ),
      );
      commit = await reconcileCommitIntent({
        transcripts,
        intents,
        runtime: options.runtime,
        intent,
      });
      return {
        ...result,
        commits: [...new Set([...result.commits, commit])].filter(
          (candidate) => !previousCommits.has(candidate),
        ),
      };
    },
  };
}
