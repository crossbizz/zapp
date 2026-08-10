// @vitest-environment node

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteRequest, GatewayStreamEvent } from "@zapp/model-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryTestDb } from "@/testing/test_db";
import {
  configureLocalAgentStreamHandler,
  handleLocalAgentStream,
} from "@/zapp/pro_stubs/main";
import { LocalWorkspaceRuntime } from "./local";
import { createLocalAgentStreamHandler } from "./local-agent-handler";

const roots: string[] = [];
const SESSION = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org_01J00000000000000000000000",
  projectId: "proj_01J00000000000000000000000",
  runId: "run_01J00000000000000000000000",
  taskId: "task_01J00000000000000000000000",
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop local-agent chat composition", () => {
  it("replaces the removed Pro stub with the production local handler", async () => {
    const delegate = vi.fn(async () => true);
    configureLocalAgentStreamHandler(delegate);

    await expect(
      handleLocalAgentStream(
        { sender: {} } as never,
        { chatId: 1, prompt: "edit" },
        new AbortController(),
        {
          placeholderMessageId: 2,
          acceptedUserMessageId: 1,
          systemPrompt: "system",
          dyadRequestId: "request",
        },
      ),
    ).resolves.toBe(true);
    expect(delegate).toHaveBeenCalledOnce();
  });

  it("runs consecutive contained local edits after relaunch, applies each commit, and switches mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "zapp-local-handler-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    const runtime = new LocalWorkspaceRuntime(root);
    for (const args of [
      ["init"],
      ["config", "user.email", "desktop@example.test"],
      ["config", "user.name", "Desktop Runtime"],
      ["commit", "--allow-empty", "-m", "initial"],
    ]) {
      await expect(
        runtime.exec({ cmd: "git", args, timeoutMs: 5_000 }),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
    const database = createInMemoryTestDb();
    database.$client
      .prepare("INSERT INTO apps (id, name, path) VALUES (?, ?, ?)")
      .run(7, "Local project", root);
    database.$client
      .prepare("INSERT INTO chats (id, app_id, title) VALUES (?, ?, ?)")
      .run(42, 7, "Local chat");
    database.$client
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
      )
      .run(99, 42, "assistant", "");
    database.$client
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
      )
      .run(100, 42, "assistant", "");
    database.$client
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
      )
      .run(101, 42, "assistant", "");
    const turns: GatewayStreamEvent[][] = [
      [
        {
          type: "tool-call",
          toolCallId: "write-1",
          toolName: "write_file",
          input: { path: "src/App.tsx", content: "export const App = 1;\n" },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        { type: "text-delta", text: "Implemented the local edit." },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "stop",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "write-2",
          toolName: "write_file",
          input: {
            path: "src/Other.tsx",
            content: "export const Other = 2;\n",
          },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        { type: "text-delta", text: "Implemented the follow-up edit." },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "stop",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        { type: "text-delta", text: "The local project is ready." },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "stop",
          totalTokens: 10,
        },
        { type: "done" },
      ],
    ];
    let turn = 0;
    const completionRequests: CompleteRequest[] = [];
    const platform = {
      ensureSession: vi.fn(async () => SESSION),
      gateway: vi.fn(() => ({
        async *stream(
          request: CompleteRequest,
        ): AsyncIterable<GatewayStreamEvent> {
          completionRequests.push(request);
          const events = turns[turn++];
          if (events === undefined) throw new Error("unexpected gateway call");
          yield* events;
        },
      })),
    };
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const sender = {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel: string, payload: unknown) =>
        sent.push({ channel, payload }),
    };
    const handler = createLocalAgentStreamHandler({
      database: database.$client,
      platform,
      redact: (value) => value.replaceAll("planted-secret", "[REDACTED]"),
    });

    await expect(
      handler(
        { sender } as never,
        { chatId: 42, streamId: 5, prompt: "Edit the page" },
        new AbortController(),
        {
          placeholderMessageId: 99,
          acceptedUserMessageId: 501,
          systemPrompt: "Build the requested local change.",
          dyadRequestId: "request-1",
        },
      ),
    ).resolves.toBe(true);

    await expect(
      createLocalAgentStreamHandler({
        database: database.$client,
        platform,
        redact: (value) => value.replaceAll("planted-secret", "[REDACTED]"),
      })(
        { sender } as never,
        { chatId: 42, streamId: 6, prompt: "Add the follow-up module" },
        new AbortController(),
        {
          placeholderMessageId: 100,
          acceptedUserMessageId: 502,
          systemPrompt: "Build the requested local change.",
          dyadRequestId: "request-2",
        },
      ),
    ).resolves.toBe(true);

    await expect(
      createLocalAgentStreamHandler({
        database: database.$client,
        platform,
        redact: (value) => value.replaceAll("planted-secret", "[REDACTED]"),
      })(
        { sender } as never,
        { chatId: 42, streamId: 7, prompt: "Summarize the local project" },
        new AbortController(),
        {
          placeholderMessageId: 101,
          acceptedUserMessageId: 503,
          systemPrompt: "Answer questions about the local project.",
          dyadRequestId: "request-3",
          readOnly: true,
        },
      ),
    ).resolves.toBe(true);

    expect(turn).toBe(5);
    await expect(runtime.readFile("src/App.tsx")).resolves.toEqual(
      new TextEncoder().encode("export const App = 1;\n"),
    );
    await expect(runtime.readFile("src/Other.tsx")).resolves.toEqual(
      new TextEncoder().encode("export const Other = 2;\n"),
    );
    expect(
      database.$client
        .prepare("SELECT content, commit_hash FROM messages WHERE id = ?")
        .get(99),
    ).toEqual({
      content: "Implemented the local edit.",
      commit_hash: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });
    const followUp = database.$client
      .prepare("SELECT content, commit_hash FROM messages WHERE id = ?")
      .get(100) as { content: string; commit_hash: string };
    expect(followUp).toEqual({
      content: "Implemented the follow-up edit.",
      commit_hash: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });
    const first = database.$client
      .prepare("SELECT commit_hash FROM messages WHERE id = ?")
      .get(99) as { commit_hash: string };
    expect(followUp.commit_hash).not.toBe(first.commit_hash);
    expect(
      database.$client
        .prepare("SELECT content, commit_hash FROM messages WHERE id = ?")
        .get(101),
    ).toEqual({
      content: "The local project is ready.",
      commit_hash: null,
    });
    expect(
      new Set(completionRequests.map((request) => request.completionId)),
    ).toHaveLength(5);
    expect(JSON.stringify(completionRequests.at(2)?.messages)).toContain(
      "Add the follow-up module",
    );
    expect(JSON.stringify(completionRequests.at(4)?.messages)).toContain(
      "Summarize the local project",
    );
    expect(
      completionRequests.at(4)?.tools?.map((tool) => tool.name),
    ).not.toContain("write_file");
    for (const request of completionRequests) {
      expect(request.tools?.map((tool) => tool.name) ?? []).not.toEqual(
        expect.arrayContaining([
          "install_dependency",
          "run_command",
          "run_dev_server",
          "restart_dev_server",
          "run_build",
          "run_typecheck",
          "run_lint",
          "run_unit_tests",
          "run_integration_tests",
        ]),
      );
    }
    expect(sent).toContainEqual({
      channel: "chat:response:end",
      payload: expect.objectContaining({
        chatId: 42,
        streamId: 5,
        updatedFiles: true,
      }),
    });
    expect(sent).toContainEqual({
      channel: "chat:response:end",
      payload: expect.objectContaining({
        chatId: 42,
        streamId: 7,
        updatedFiles: false,
      }),
    });
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["log", "HEAD", "--format=%s"],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      stdout: expect.stringMatching(
        new RegExp(`(?:zapp local agent ${SESSION.runId}\\n){2}`, "u"),
      ),
    });
    database.$client.close();
  });

  it("never places an unknown ignored project secret in model context or durable transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "zapp-local-secret-boundary-"));
    roots.push(root);
    const runtime = new LocalWorkspaceRuntime(root);
    for (const args of [
      ["init"],
      ["config", "user.email", "desktop@example.test"],
      ["config", "user.name", "Desktop Runtime"],
      ["commit", "--allow-empty", "-m", "initial"],
    ]) {
      await expect(
        runtime.exec({ cmd: "git", args, timeoutMs: 5_000 }),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
    const unknownSecret = "unknown-project-secret-must-not-leave-host";
    const gitMetadataSecret = "unknown-git-metadata-secret";
    await runtime.writeFile(
      ".env",
      new TextEncoder().encode(`PRIVATE_PROJECT_TOKEN=${unknownSecret}\n`),
    );
    await expect(
      runtime.exec({
        cmd: "git",
        args: ["config", "zapp.private", gitMetadataSecret],
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const database = createInMemoryTestDb();
    database.$client
      .prepare("INSERT INTO apps (id, name, path) VALUES (?, ?, ?)")
      .run(8, "Secret project", root);
    database.$client
      .prepare("INSERT INTO chats (id, app_id, title) VALUES (?, ?, ?)")
      .run(43, 8, "Secret chat");
    database.$client
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
      )
      .run(102, 43, "assistant", "");
    const completionRequests: CompleteRequest[] = [];
    let turn = 0;
    const turns: GatewayStreamEvent[][] = [
      [
        {
          type: "tool-call",
          toolCallId: "list-readable-files",
          toolName: "list_files",
          input: { path: "." },
        },
        {
          type: "tool-call",
          toolCallId: "read-ignored-secret",
          toolName: "read_file",
          input: { path: ".env" },
        },
        {
          type: "tool-call",
          toolCallId: "read-git-metadata",
          toolName: "read_file",
          input: { path: ".git/config" },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        { type: "text-delta", text: "The ignored file was unavailable." },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "stop",
          totalTokens: 10,
        },
        { type: "done" },
      ],
    ];
    const handler = createLocalAgentStreamHandler({
      database: database.$client,
      platform: {
        ensureSession: async () => SESSION,
        gateway: () => ({
          async *stream(request: CompleteRequest) {
            completionRequests.push(request);
            yield* turns[turn++] ?? [];
          },
        }),
      },
      redact: (value) => value,
    });

    await expect(
      handler(
        {
          sender: {
            isDestroyed: () => false,
            isCrashed: () => false,
            send: () => undefined,
          },
        } as never,
        {
          chatId: 43,
          streamId: 8,
          prompt: "Inspect the ignored environment file",
        },
        new AbortController(),
        {
          placeholderMessageId: 102,
          acceptedUserMessageId: 504,
          systemPrompt: "Inspect only model-readable project files.",
          dyadRequestId: "request-secret",
        },
      ),
    ).resolves.toBe(true);

    expect(JSON.stringify(completionRequests)).not.toContain(unknownSecret);
    expect(JSON.stringify(completionRequests)).not.toContain(gitMetadataSecret);
    const advertisedTools = completionRequests[0]?.tools?.map(
      (tool) => tool.name,
    );
    expect(advertisedTools).toEqual([
      "read_file",
      "list_files",
      "write_file",
      "apply_patch",
      "copy_file",
      "rename_file",
      "delete_file",
    ]);
    const durable = database.$client
      .prepare("SELECT transcript_json FROM zapp_local_agent_sessions")
      .get() as { transcript_json: string };
    expect(durable.transcript_json).not.toContain(unknownSecret);
    expect(durable.transcript_json).not.toContain(gitMetadataSecret);
    database.$client.close();
  });

  it("replays the first accepted message without another completion or clearing its commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "zapp-local-first-replay-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    const runtime = new LocalWorkspaceRuntime(root);
    for (const args of [
      ["init"],
      ["config", "user.email", "desktop@example.test"],
      ["config", "user.name", "Desktop Runtime"],
      ["commit", "--allow-empty", "-m", "initial"],
    ]) {
      await expect(
        runtime.exec({ cmd: "git", args, timeoutMs: 5_000 }),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
    const database = createInMemoryTestDb();
    database.$client
      .prepare("INSERT INTO apps (id, name, path) VALUES (?, ?, ?)")
      .run(9, "Replay project", root);
    database.$client
      .prepare("INSERT INTO chats (id, app_id, title) VALUES (?, ?, ?)")
      .run(44, 9, "Replay chat");
    database.$client
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
      )
      .run(103, 44, "assistant", "");
    const turns: GatewayStreamEvent[][] = [
      [
        {
          type: "tool-call",
          toolCallId: "write-once",
          toolName: "write_file",
          input: {
            path: "src/Replay.ts",
            content: "export const replay = true;\n",
          },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        { type: "text-delta", text: "Applied exactly once." },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "stop",
          totalTokens: 10,
        },
        { type: "done" },
      ],
    ];
    let gatewayCalls = 0;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const handler = createLocalAgentStreamHandler({
      database: database.$client,
      platform: {
        ensureSession: async () => SESSION,
        gateway: () => ({
          async *stream(): AsyncIterable<GatewayStreamEvent> {
            const events = turns[gatewayCalls++];
            if (events === undefined) throw new Error("duplicate completion");
            yield* events;
          },
        }),
      },
      redact: (value) => value,
    });
    const sender = {
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel: string, payload: unknown) =>
        sent.push({ channel, payload }),
    };
    const invoke = () =>
      handler(
        { sender } as never,
        { chatId: 44, streamId: 9, prompt: "Apply the replay edit" },
        new AbortController(),
        {
          placeholderMessageId: 103,
          acceptedUserMessageId: 505,
          systemPrompt: "Build safely.",
          dyadRequestId: "request-replay",
        },
      );

    await expect(invoke()).resolves.toBe(true);
    const first = database.$client
      .prepare("SELECT content, commit_hash FROM messages WHERE id = ?")
      .get(103);
    await expect(invoke()).resolves.toBe(true);

    expect(gatewayCalls).toBe(2);
    expect(
      database.$client
        .prepare("SELECT content, commit_hash FROM messages WHERE id = ?")
        .get(103),
    ).toEqual(first);
    expect(sent.at(-1)).toEqual({
      channel: "chat:response:end",
      payload: expect.objectContaining({ updatedFiles: true }),
    });
    database.$client.close();
  });

  it("reports the exact partial commit when a terminal provider failure follows a mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zapp-local-partial-failure-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    const runtime = new LocalWorkspaceRuntime(root);
    for (const args of [
      ["init"],
      ["config", "user.email", "desktop@example.test"],
      ["config", "user.name", "Desktop Runtime"],
      ["commit", "--allow-empty", "-m", "initial"],
    ]) {
      await expect(
        runtime.exec({ cmd: "git", args, timeoutMs: 5_000 }),
      ).resolves.toMatchObject({ exitCode: 0 });
    }
    const database = createInMemoryTestDb();
    database.$client
      .prepare("INSERT INTO apps (id, name, path) VALUES (?, ?, ?)")
      .run(10, "Partial project", root);
    database.$client
      .prepare("INSERT INTO chats (id, app_id, title) VALUES (?, ?, ?)")
      .run(45, 10, "Partial chat");
    database.$client
      .prepare(
        "INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
      )
      .run(104, 45, "assistant", "");
    const turns: GatewayStreamEvent[][] = [
      [
        {
          type: "tool-call",
          toolCallId: "partial-write",
          toolName: "write_file",
          input: {
            path: "src/Partial.ts",
            content: "export const partial = true;\n",
          },
        },
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "tool-calls",
          totalTokens: 10,
        },
        { type: "done" },
      ],
      [
        {
          type: "usage",
          provider: "anthropic",
          model: "test",
          finishReason: "error",
          totalTokens: 3,
        },
        {
          type: "error",
          code: "provider_error",
          message: "provider interrupted",
        },
      ],
    ];
    let turn = 0;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const handler = createLocalAgentStreamHandler({
      database: database.$client,
      platform: {
        ensureSession: async () => SESSION,
        gateway: () => ({
          async *stream(): AsyncIterable<GatewayStreamEvent> {
            yield* turns[turn++] ?? [];
          },
        }),
      },
      redact: (value) => value,
    });

    await expect(
      handler(
        {
          sender: {
            isDestroyed: () => false,
            isCrashed: () => false,
            send: (channel: string, payload: unknown) =>
              sent.push({ channel, payload }),
          },
        } as never,
        { chatId: 45, streamId: 10, prompt: "Apply a partial edit" },
        new AbortController(),
        {
          placeholderMessageId: 104,
          acceptedUserMessageId: 506,
          systemPrompt: "Build safely.",
          dyadRequestId: "request-partial",
        },
      ),
    ).resolves.toBe(false);

    expect(
      database.$client
        .prepare("SELECT commit_hash FROM messages WHERE id = ?")
        .get(104),
    ).toEqual({ commit_hash: expect.stringMatching(/^[a-f0-9]{40}$/u) });
    expect(sent.at(-1)).toEqual({
      channel: "chat:response:end",
      payload: expect.objectContaining({ updatedFiles: true }),
    });
    database.$client.close();
  });
});
