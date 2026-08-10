// @vitest-environment node

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolRegistryDependencies } from "@zapp/agent-tools";
import type { ToolName } from "@zapp/contracts";
import type { GatewayStreamEvent } from "@zapp/model-gateway";
import type { SessionInput } from "@zapp/orchestrator-worker/session";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryTestDb } from "@/testing/test_db";
import { LocalWorkspaceRuntime } from "./local";
import {
  createLocalAgentSession,
  type LocalAgentSessionOptions,
  SqliteTranscriptStore,
} from "./local-session";

const roots: string[] = [];

function redact(value: string): string {
  return value.replaceAll("planted-local-secret", "[REDACTED]");
}

function toolRegistry(runtime: LocalWorkspaceRuntime): ToolRegistry {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new Error("This cloud-only tool is unavailable in local mode"),
    );
  const dependencies: ToolRegistryDependencies = {
    runtime,
    redactor: { redact },
    projectData: {
      readLogs: unavailable,
      readTestResults: unavailable,
      readDatabaseSchema: unavailable,
      readLatestProjectContract: unavailable,
    },
    migrations: { executeMigration: unavailable },
    environment: { setEnvironmentVariable: unavailable },
    browser: {
      runBrowserTests: unavailable,
      captureScreenshot: unavailable,
      inspectConsole: unavailable,
      inspectNetwork: unavailable,
    },
    preview: { createPreview: unavailable, runPreviewSmokeTest: unavailable },
    release: {
      createReleaseCandidate: unavailable,
      getReadiness: unavailable,
      approve: unavailable,
      deploy: unavailable,
      rollback: unavailable,
      getEvidence: unavailable,
    },
    deploymentHealth: { checkDeploymentHealth: unavailable },
  };
  return new ToolRegistry(dependencies);
}

function sessionInput(
  tools: readonly ToolName[] = ["write_file"],
  redirect: NonNullable<SessionInput["control"]>["redirect"] = null,
  identity = "1",
): SessionInput {
  return {
    runId: `local-run-${identity}`,
    taskId: `local-task-${identity}`,
    role: "builder",
    mode: "build",
    context: {
      role: "builder",
      scope: {
        organizationId: "org-local",
        projectId: "project-local",
        runId: `local-run-${identity}`,
      },
      taskId: `local-task-${identity}`,
      tokenBudget: 20_000,
      tokenCount: 8,
      sections: [
        {
          kind: "currentTask",
          content: "Change src/App.tsx and commit the edit.",
          tokenCount: 8,
          sourceArtifactIds: [],
          sourceEventIds: [],
        },
      ],
    },
    tools: [...tools],
    budgets: { maxTurns: 10, maxTokens: 20_000, maxWallClockMs: 30_000 },
    control: { yieldAfterTool: true, redirect },
  };
}

async function initializeGit(runtime: LocalWorkspaceRuntime): Promise<void> {
  for (const args of [
    ["init"],
    ["config", "user.email", "desktop@example.test"],
    ["config", "user.name", "Desktop Runtime"],
  ]) {
    await expect(
      runtime.exec({ cmd: "git", args, timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ exitCode: 0 });
  }
}

function scriptedGateway(turns: readonly (readonly GatewayStreamEvent[])[]) {
  let index = 0;
  return {
    get calls(): number {
      return index;
    },
    async *stream(): AsyncIterable<GatewayStreamEvent> {
      const turn = turns[index];
      index += 1;
      if (turn === undefined) throw new Error("Unexpected gateway call");
      for (const event of turn) yield event;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop local agent session", () => {
  it("resumes the AR-6 loop from SQLite and commits a local edit after app restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "zapp-local-session-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    class LostCommitResponseRuntime extends LocalWorkspaceRuntime {
      private loseCommitResponse = true;

      override async exec(input: Parameters<LocalWorkspaceRuntime["exec"]>[0]) {
        if (input.cmd === "git" && input.args[0] === "reset") {
          throw new Error("primary index mutation is forbidden");
        }
        const result = await super.exec(input);
        if (
          input.cmd === "git" &&
          input.args[0] === "update-ref" &&
          result.exitCode === 0 &&
          this.loseCommitResponse
        ) {
          this.loseCommitResponse = false;
          throw new Error("simulated lost Git commit response");
        }
        return result;
      }
    }
    const runtime = new LostCommitResponseRuntime(root);
    await initializeGit(runtime);
    await runtime.writeFile(
      "user-staged.txt",
      new TextEncoder().encode("user-owned staged change\n"),
    );
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["add", "--", "user-staged.txt"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const database = createInMemoryTestDb();
    const gateway = scriptedGateway([
      [
        {
          type: "tool-call",
          toolCallId: "call-write",
          toolName: "write_file",
          input: {
            path: "src/App.tsx",
            content: "export const App = 'local';\n",
          },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        { type: "text-delta", text: "Implemented and committed locally." },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "stop",
          totalTokens: 10,
        },
        { type: "done" },
      ],
    ]);
    const registry = toolRegistry(runtime);
    const options = {
      database: database.$client,
      gateway,
      tools: registry,
      runtime,
      redact,
      prompts: {
        builder: "Build the requested local change.",
        planner: "Plan the local change.",
        verifier: "Verify the local change.",
        summarizer: "Summarize the local change.",
      },
    } as const;

    await expect(
      createLocalAgentSession(options).run(sessionInput()),
    ).resolves.toMatchObject({
      status: "yielded",
    });
    await expect(
      createLocalAgentSession(options).run(sessionInput()),
    ).rejects.toThrow("simulated lost Git commit response");
    const recovered =
      await createLocalAgentSession(options).run(sessionInput());
    expect(recovered).toMatchObject({
      status: "completed",
      summary: "Implemented and committed locally.",
      commits: [expect.any(String)],
    });
    if (recovered.status !== "completed") {
      throw new Error("Expected a completed recovered local session");
    }
    const [recoveredCommit] = recovered.commits;
    if (recoveredCommit === undefined) {
      throw new Error("Expected a recovered local commit");
    }

    expect(gateway.calls).toBe(2);
    await expect(runtime.readFile("src/App.tsx")).resolves.toEqual(
      new TextEncoder().encode("export const App = 'local';\n"),
    );
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["log", "--all", "--oneline"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("zapp local agent local-run-1"),
    });
    await expect(
      new SqliteTranscriptStore(database.$client).load({
        runId: "local-run-1",
        taskId: "local-task-1",
      }),
    ).resolves.toMatchObject({
      terminalStatus: "completed",
      turns: 2,
      commits: [expect.any(String)],
    });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["log", "--all", "--format=%s"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringMatching(/^zapp local agent local-run-1$/mu),
    });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["show", "--format=", "--name-only", recoveredCommit],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      stdout: expect.not.stringContaining("user-staged.txt"),
    });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["status", "--short", "--", "user-staged.txt"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ stdout: "A  user-staged.txt\n" });
    database.$client.close();
  });

  it("loses the ref CAS cleanly after a concurrent commit and checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "zapp-local-ref-cas-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    class ConcurrentCheckoutRuntime extends LocalWorkspaceRuntime {
      private movedHead = false;

      override async exec(input: Parameters<LocalWorkspaceRuntime["exec"]>[0]) {
        if (
          input.cmd === "git" &&
          ((input.args[0] === "commit" &&
            input.env?.GIT_INDEX_FILE !== undefined) ||
            input.args[0] === "update-ref") &&
          !this.movedHead
        ) {
          this.movedHead = true;
          await this.writeFile(
            "user-concurrent.txt",
            new TextEncoder().encode("must survive the agent commit\n"),
          );
          await super.exec({
            cmd: "git",
            args: ["add", "--", "user-concurrent.txt"],
            timeoutMs: 5_000,
          });
          await super.exec({
            cmd: "git",
            args: ["commit", "-m", "Concurrent user commit"],
            timeoutMs: 5_000,
          });
          await super.exec({
            cmd: "git",
            args: ["switch", "-c", "concurrent-user-branch"],
            timeoutMs: 5_000,
          });
        }
        return await super.exec(input);
      }
    }
    const runtime = new ConcurrentCheckoutRuntime(root);
    await initializeGit(runtime);
    await runtime.writeFile(
      "baseline.txt",
      new TextEncoder().encode("baseline must remain\n"),
    );
    await expect(
      runtime.git({
        operation: "add_commit",
        paths: ["baseline.txt"],
        message: "Local baseline",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const initialBranchResult = await runtime.exec({
      cmd: "git",
      args: ["symbolic-ref", "--short", "HEAD"],
      timeoutMs: 5_000,
    });
    expect(initialBranchResult.exitCode).toBe(0);
    const initialBranch = initialBranchResult.stdout.trim();

    const database = createInMemoryTestDb();
    const gateway = scriptedGateway([
      [
        {
          type: "tool-call",
          toolCallId: "call-write-cas",
          toolName: "write_file",
          input: {
            path: "src/App.tsx",
            content: "export const App = 'fenced';\n",
          },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        { type: "text-delta", text: "Committed on the owned branch." },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "stop",
          totalTokens: 10,
        },
        { type: "done" },
      ],
    ]);
    const options = {
      database: database.$client,
      gateway,
      tools: toolRegistry(runtime),
      runtime,
      redact,
      prompts: {
        builder: "Build the requested local change.",
        planner: "Plan the local change.",
        verifier: "Verify the local change.",
        summarizer: "Summarize the local change.",
      },
    } as const;

    await expect(
      createLocalAgentSession(options).run(sessionInput()),
    ).resolves.toMatchObject({ status: "yielded" });
    const agentResult =
      await createLocalAgentSession(options).run(sessionInput());
    expect(agentResult).toMatchObject({
      status: "completed",
      commits: [expect.any(String)],
    });
    if (agentResult.status !== "completed") {
      throw new Error("Expected a completed fenced local session");
    }
    const [agentCommit] = agentResult.commits;
    if (agentCommit === undefined) throw new Error("Expected an agent commit");
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["show", "HEAD:user-concurrent.txt"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "must survive the agent commit\n",
    });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["show", `${initialBranch}:user-concurrent.txt`],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "must survive the agent commit\n",
    });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["show", `${initialBranch}:baseline.txt`],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "baseline must remain\n" });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["cat-file", "-e", `${initialBranch}:src/App.tsx`],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ exitCode: 128 });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["show", `${agentCommit}:src/App.tsx`],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "export const App = 'fenced';\n",
    });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["diff", "--cached", "--name-only"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ stdout: "" });
    database.$client.close();
  });

  it("commits the typed changed-path manifest for every filesystem mutator", async () => {
    const root = await mkdtemp(join(tmpdir(), "zapp-local-mutations-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    const runtime = new LocalWorkspaceRuntime(root);
    await initializeGit(runtime);
    for (const [path, content] of [
      ["src/update.txt", "old update\n"],
      ["src/delete.txt", "delete me\n"],
    ] as const) {
      await runtime.writeFile(path, new TextEncoder().encode(content));
    }
    await expect(
      runtime.git({
        operation: "add_commit",
        paths: ["src/update.txt", "src/delete.txt"],
        message: "Local mutation baseline",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    const database = createInMemoryTestDb();
    const mutationTurns: Array<readonly GatewayStreamEvent[]> = [
      [
        {
          type: "tool-call",
          toolCallId: "write-create",
          toolName: "write_file",
          input: { path: "src/create.txt", content: "created\n" },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "write-update",
          toolName: "write_file",
          input: { path: "src/update.txt", content: "new update\n" },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "copy",
          toolName: "copy_file",
          input: { source: "src/create.txt", destination: "src/copied.txt" },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "rename",
          toolName: "rename_file",
          input: { source: "src/copied.txt", destination: "src/renamed.txt" },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "delete",
          toolName: "delete_file",
          input: { path: "src/delete.txt" },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "claude-test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
    ];
    const terminalTurn: readonly GatewayStreamEvent[] = [
      { type: "text-delta", text: "Filesystem mutation completed." },
      {
        type: "usage",
        provider: "anthropic",
        model: "claude-test",
        finishReason: "stop",
        totalTokens: 10,
      },
      { type: "done" },
    ];
    const gateway = scriptedGateway(
      mutationTurns.flatMap((turn) => [turn, terminalTurn]),
    );
    const options = {
      database: database.$client,
      gateway,
      tools: toolRegistry(runtime),
      runtime,
      redact,
      prompts: {
        builder: "Build the requested local change.",
        planner: "Plan the local change.",
        verifier: "Verify the local change.",
        summarizer: "Summarize the local change.",
      },
    } as const;
    const tools = [
      "write_file",
      "copy_file",
      "rename_file",
      "delete_file",
    ] as const;

    const manifests: unknown[] = [];
    for (let turn = 0; turn < mutationTurns.length; turn += 1) {
      const input = sessionInput(tools, null, String(turn + 1));
      await expect(
        createLocalAgentSession(options).run(input),
      ).resolves.toMatchObject({ status: "yielded" });
      const transcript = await new SqliteTranscriptStore(database.$client).load(
        {
          runId: input.runId,
          taskId: input.taskId,
        },
      );
      manifests.push(transcript?.changedPaths);
      await expect(
        createLocalAgentSession(options).run(input),
      ).resolves.toMatchObject({
        status: "completed",
      });
    }
    expect(manifests).toEqual([
      ["src/create.txt"],
      ["src/update.txt"],
      ["src/copied.txt"],
      ["src/copied.txt", "src/renamed.txt"],
      ["src/delete.txt"],
    ]);
    const changed = await runtime.exec({
      cmd: "git",
      args: ["log", "--all", "--name-status", "--format="],
      timeoutMs: 5_000,
    });
    expect(changed.stdout).toContain("A\tsrc/create.txt");
    expect(changed.stdout).toContain("M\tsrc/update.txt");
    expect(changed.stdout).toContain("D\tsrc/delete.txt");
    expect(changed.stdout).toContain("A\tsrc/renamed.txt");
    database.$client.close();
  });

  it("fails closed when local session redaction is omitted", () => {
    const database = createInMemoryTestDb();
    const root = join(tmpdir(), "zapp-local-redactor-unreachable");
    const runtime = new LocalWorkspaceRuntime(root);
    const invalid = {
      database: database.$client,
      gateway: scriptedGateway([]),
      tools: toolRegistry(runtime),
      runtime,
      prompts: {
        builder: "builder",
        planner: "planner",
        verifier: "verifier",
        summarizer: "summarizer",
      },
    } as unknown as LocalAgentSessionOptions;
    expect(() => createLocalAgentSession(invalid)).toThrow(/redactor/iu);
    database.$client.close();
  });
});
