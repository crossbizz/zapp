import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { screen, waitFor } from "@testing-library/react";
import { eq } from "drizzle-orm";

import { apps, chats, messages } from "@/db/schema";
import { ensureGitLineEndingPolicy } from "@/ipc/utils/git_utils";
import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";

describe("local-agent basic flows (integration)", () => {
  let harness: HybridChatHarness;
  let appCounter = 0;

  beforeAll(async () => {
    harness = await setupHybridChatHarness({
      electronMock: h,
      engine: true,
      chatMode: "local-agent",
      settings: {
        isTestMode: true,
        enableDyadPro: true,
        providerSettings: { auto: { apiKey: { value: "testdyadkey" } } },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  async function createMinimalApp(options: {
    name: string;
    needsAppBlueprint?: boolean;
  }) {
    appCounter += 1;
    const fixtureAppDir = path.join(
      process.cwd(),
      "e2e-tests",
      "fixtures",
      "import-app",
      "minimal",
    );
    const appDir = path.join(
      path.dirname(harness.appDir),
      `${options.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${appCounter}`,
    );
    fs.cpSync(fixtureAppDir, appDir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.email=test@example.com",
          "-c",
          "user.name=Test User",
          ...args,
        ],
        { cwd: appDir, stdio: "pipe" },
      );
    git("init");
    await ensureGitLineEndingPolicy({
      path: appDir,
      writeGitattributes: true,
    });
    git("add", "-A");
    git("commit", "-m", "init");

    const [appRow] = await harness.db
      .insert(apps)
      .values({
        name: options.name,
        path: appDir,
        needsAppBlueprint: options.needsAppBlueprint ?? false,
      })
      .returning();
    const [chatRow] = await harness.db
      .insert(chats)
      .values({ appId: appRow.id, chatMode: "local-agent" })
      .returning();
    return { appId: appRow.id, chatId: chatRow.id, appDir };
  }

  // sentEvents accumulates for the harness lifetime; baseline per test so an
  // error in one test doesn't also fail every later test in the file.
  let errorEventsBaseline = 0;
  function allErrorEvents() {
    return harness.bridge.sentEvents.filter(
      (e) => e.channel === "chat:response:error",
    );
  }
  function errorEvents() {
    return allErrorEvents().slice(errorEventsBaseline);
  }
  beforeEach(() => {
    errorEventsBaseline = harness ? allErrorEvents().length : 0;
  });

  it("reads a file, edits it, and persists the result", async () => {
    const app = await createMinimalApp({ name: "Read Edit" });
    harness.mount({ chatId: app.chatId, appId: app.appId });

    const { send } = await harness.typeInChat("tc=local-agent/read-then-edit", {
      chatId: app.chatId,
    });
    send();

    await waitFor(
      () =>
        expect(
          screen.getByText(/updated the title from 'Minimal imported app'/i),
        ).toBeTruthy(),
      { timeout: 20_000 },
    );
    await harness.waitForStreamEnd(app.chatId);

    const storedMessages = await harness.db.query.messages.findMany({
      where: eq(messages.chatId, app.chatId),
    });
    expect(storedMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(storedMessages.at(-1)?.content).toContain("UPDATED imported app");
    const transcript = harness.db.$client
      .prepare<[string, string], { transcript_json: string }>(
        `SELECT transcript_json
           FROM zapp_local_agent_sessions
          WHERE run_id = ? AND task_id = ?`,
      )
      .get(
        `run_${String(app.chatId).padStart(26, "0")}`,
        `task_${String(app.chatId).padStart(26, "0")}`,
      );
    const persistedTranscript = JSON.parse(transcript!.transcript_json) as {
      changedPaths: string[];
      successfulToolNames: string[];
      messages: unknown[];
      provenance: unknown[];
    };
    expect(persistedTranscript).toMatchObject({
      changedPaths: ["src/App.tsx"],
      successfulToolNames: ["write_file"],
    });
    const receipt = harness.db.$client
      .prepare<
        [string, string],
        { status: string | null; commits_json: string | null }
      >(
        `SELECT status, commits_json
           FROM zapp_local_agent_operation_receipts
          WHERE run_id = ? AND task_id = ?`,
      )
      .get(
        `run_${String(app.chatId).padStart(26, "0")}`,
        `task_${String(app.chatId).padStart(26, "0")}`,
      );
    expect(receipt).toMatchObject({
      status: "completed",
      commits_json: expect.stringMatching(/^\["[a-f0-9]{40}"\]$/u),
    });
    const [agentCommit] = JSON.parse(receipt!.commits_json!) as [string];
    expect(
      fs
        .readFileSync(path.join(app.appDir, "src/App.tsx"), "utf8")
        .replace(/\r\n/g, "\n"),
    ).toBe(
      "const App = () => <div>UPDATED imported app</div>;\n\nexport default App;\n",
    );
    expect(
      execFileSync("git", ["show", `${agentCommit}:src/App.tsx`], {
        cwd: app.appDir,
        encoding: "utf8",
      }).replace(/\r\n/g, "\n"),
    ).toBe(
      "const App = () => <div>UPDATED imported app</div>;\n\nexport default App;\n",
    );
    expect(
      execFileSync("git", ["status", "--short", "--", "src/App.tsx"], {
        cwd: app.appDir,
        encoding: "utf8",
      }),
    ).toBe("");
    expect(errorEvents()).toHaveLength(0);
  }, 60_000);
});
