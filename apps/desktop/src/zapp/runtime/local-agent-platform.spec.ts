// @vitest-environment node

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createInMemoryTestDb } from "@/testing/test_db";
import {
  createDesktopLocalAgentPlatform,
  type LocalAgentPlatformAuth,
} from "./local-agent-platform";

const SESSION = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org_01J00000000000000000000000",
  projectId: "proj_01J00000000000000000000000",
  runId: "run_01J00000000000000000000000",
  taskId: "task_01J00000000000000000000000",
} as const;

function auth(): LocalAgentPlatformAuth {
  return {
    snapshot: () => ({
      status: "authenticated",
      selectedOrganizationId: SESSION.organizationId,
      cloudEnabled: true,
    }),
    authorizationHeader: () => "Bearer memory-only-token",
  };
}

describe("desktop local-agent platform boundary", () => {
  it("replays one durable public session identity and streams through the authenticated SDK", async () => {
    const database = createInMemoryTestDb().$client;
    database
      .prepare("INSERT INTO apps (id, name, path) VALUES (?, ?, ?)")
      .run(7, "Local project", "/tmp/local-project");
    database
      .prepare("INSERT INTO chats (id, app_id, title) VALUES (?, ?, ?)")
      .run(42, 7, "Local chat");
    const requests: Array<{ url: string; body: unknown; headers: Headers }> =
      [];
    const fetch = vi.fn(async (input: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body)) as unknown;
      requests.push({ url: input.pathname, body, headers });
      if (input.pathname === "/v1/local-agent/sessions") {
        return new Response(JSON.stringify({ session: SESSION }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        [
          `data: ${JSON.stringify({ type: "text-delta", text: "done" })}\n\n`,
          `data: ${JSON.stringify({ type: "done" })}\n\n`,
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const first = createDesktopLocalAgentPlatform({
      auth: auth(),
      baseUrl: "https://api.example.test",
      database,
      fetch,
      randomUUID: () => SESSION.sessionId,
    });
    const second = createDesktopLocalAgentPlatform({
      auth: auth(),
      baseUrl: "https://api.example.test",
      database,
      fetch,
      randomUUID,
    });

    const created = await first.ensureSession({
      chatId: 42,
      localProjectName: "Local project",
    });
    const replayed = await second.ensureSession({
      chatId: 42,
      localProjectName: "Renamed project",
    });
    const events = [];
    for await (const event of second.gateway(replayed).stream(
      {
        completionId: `cmp_${"a".repeat(64)}`,
        organizationId: SESSION.organizationId,
        projectId: SESSION.projectId,
        runId: SESSION.runId,
        taskId: SESSION.taskId,
        agentRole: "builder",
        messages: [{ role: "user", content: "edit the page" }],
        cacheBreakpointMessageIndexes: [],
        maxInputTokens: 100,
        maxOutputTokens: 100,
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(created).toEqual(SESSION);
    expect(replayed).toEqual(SESSION);
    expect(requests.map((request) => request.url)).toEqual([
      "/v1/local-agent/sessions",
      "/v1/local-agent/sessions",
      `/v1/local-agent/sessions/${SESSION.sessionId}/completions`,
    ]);
    expect(requests[0]?.body).toEqual({
      sessionId: SESSION.sessionId,
      localProjectName: "Local project",
    });
    expect(requests[1]?.body).toEqual({
      sessionId: SESSION.sessionId,
      localProjectName: "Local project",
    });
    expect(requests[2]?.body).not.toHaveProperty("organizationId");
    expect(requests[2]?.body).not.toHaveProperty("projectId");
    expect(requests[2]?.body).not.toHaveProperty("runId");
    expect(requests[2]?.body).not.toHaveProperty("sessionId");
    expect(requests[2]?.headers.get("authorization")).toBe(
      "Bearer memory-only-token",
    );
    expect(requests[2]?.headers.get("x-organization-id")).toBe(
      SESSION.organizationId,
    );
    expect(events).toEqual([
      { type: "text-delta", text: "done" },
      { type: "done" },
    ]);
  });

  it("replays one completion identity after a partial public SSE response", async () => {
    const database = createInMemoryTestDb().$client;
    database
      .prepare("INSERT INTO apps (id, name, path) VALUES (?, ?, ?)")
      .run(7, "Local project", "/tmp/local-project");
    database
      .prepare("INSERT INTO chats (id, app_id, title) VALUES (?, ?, ?)")
      .run(42, 7, "Local chat");
    const completionBodies: string[] = [];
    let completionAttempt = 0;
    const fetch = vi.fn(async (input: URL, init: RequestInit) => {
      if (input.pathname === "/v1/local-agent/sessions") {
        return new Response(JSON.stringify({ session: SESSION }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      completionBodies.push(String(init.body));
      completionAttempt += 1;
      return new Response(
        completionAttempt === 1
          ? 'data: {"type":"text-delta","text":"partial"}\n\n'
          : 'data: {"type":"text-delta","text":"recovered"}\n\ndata: {"type":"done"}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const platform = createDesktopLocalAgentPlatform({
      auth: auth(),
      baseUrl: "https://api.example.test",
      database,
      fetch,
      randomUUID: () => SESSION.sessionId,
    });
    const session = await platform.ensureSession({
      chatId: 42,
      localProjectName: "Local project",
    });
    const request = {
      completionId: `cmp_${"b".repeat(64)}`,
      organizationId: SESSION.organizationId,
      projectId: SESSION.projectId,
      runId: SESSION.runId,
      taskId: SESSION.taskId,
      agentRole: "builder" as const,
      messages: [{ role: "user" as const, content: "edit the page" }],
      cacheBreakpointMessageIndexes: [],
      maxInputTokens: 100,
      maxOutputTokens: 100,
    };
    const events = [];
    for await (const event of platform
      .gateway(session)
      .stream(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(completionBodies).toEqual([
      JSON.stringify(completionBodyForTest(request)),
      JSON.stringify(completionBodyForTest(request)),
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "recovered" },
      { type: "done" },
    ]);
    database.close();
  });
});

function completionBodyForTest(request: Record<string, unknown>) {
  const {
    organizationId: _organizationId,
    projectId: _projectId,
    runId: _runId,
    taskId: _taskId,
    ...body
  } = request;
  return body;
}
