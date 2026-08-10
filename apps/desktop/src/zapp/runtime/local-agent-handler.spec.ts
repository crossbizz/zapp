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
          input: { path: "src/Other.tsx", content: "export const Other = 2;\n" },
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
        async *stream(request: CompleteRequest): AsyncIterable<GatewayStreamEvent> {
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
    expect(new Set(completionRequests.map((request) => request.completionId))).toHaveLength(5);
    expect(JSON.stringify(completionRequests.at(2)?.messages)).toContain(
      "Add the follow-up module",
    );
    expect(JSON.stringify(completionRequests.at(4)?.messages)).toContain(
      "Summarize the local project",
    );
    expect(completionRequests.at(4)?.tools?.map((tool) => tool.name)).not.toContain(
      "write_file",
    );
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
});
