import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { ToolRegistry, type ToolRegistryDependencies } from "@zapp/agent-tools";
import {
  LocalAgentSessionSchema,
  type LocalAgentSession,
  type ToolName,
} from "@zapp/contracts";
import type { CompleteRequest, GatewayStreamEvent } from "@zapp/model-gateway";
import type { SessionGateway } from "@zapp/orchestrator-worker/session";
import { z } from "zod";

import type {
  ChatStreamChunkPayload,
  ChatStreamEndPayload,
  ChatStreamErrorPayload,
} from "@/chat_stream/protocol";
import type { ChatStreamParams } from "@/ipc/types";
import { safeSend } from "@/ipc/utils/safe_sender";
import { hashPrefix } from "@/lib/prefixHash";
import { getDyadAppPath } from "@/paths/paths";

import { LocalWorkspaceRuntime } from "./local";
import { createLocalAgentSession } from "./local-session";

const LocalProjectSchema = z
  .object({ name: z.string().min(1), path: z.string().min(1) })
  .strict();

const READ_TOOLS = [
  "read_file",
  "list_files",
  "file_stats",
  "search_code",
  "grep",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
] as const satisfies readonly ToolName[];

const LOCAL_TOOLS = [
  ...READ_TOOLS,
  "write_file",
  "apply_patch",
  "copy_file",
  "rename_file",
  "delete_file",
  "create_branch",
  "create_checkpoint",
  "commit_changes",
  "restore_file",
  "revert_commit",
  "merge_branch",
] as const satisfies readonly ToolName[];

function computeStreamingPatch(fullResponse: string, lastSentContent: string) {
  if (fullResponse === lastSentContent) return null;
  let offset = 0;
  const limit = Math.min(fullResponse.length, lastSentContent.length);
  while (
    offset < limit &&
    fullResponse.charCodeAt(offset) === lastSentContent.charCodeAt(offset)
  ) {
    offset += 1;
  }
  return {
    offset,
    content: fullResponse.slice(offset),
    prefixHash: offset > 0 ? hashPrefix(fullResponse, offset) : undefined,
  };
}

export interface DesktopLocalAgentPlatform {
  ensureSession(input: {
    readonly chatId: number;
    readonly localProjectName: string;
  }): Promise<LocalAgentSession>;
  gateway(session: LocalAgentSession): SessionGateway;
}

export interface DesktopLocalAgentStreamOptions {
  readonly placeholderMessageId: number;
  readonly acceptedUserMessageId: number;
  readonly systemPrompt: string;
  readonly dyadRequestId: string;
  readonly readOnly?: boolean;
  readonly planModeOnly?: boolean;
}

function continuationOperationKey(chatId: number, userMessageId: number): `op_${string}` {
  return `op_${createHash("sha256")
    .update(JSON.stringify([chatId, userMessageId]))
    .digest("hex")}`;
}

export type DesktopLocalAgentStreamHandler = (
  event: IpcMainInvokeEvent,
  request: ChatStreamParams,
  abortController: AbortController,
  options: DesktopLocalAgentStreamOptions,
) => Promise<boolean>;

function unavailable(): Promise<never> {
  return Promise.reject(
    new Error("This cloud-only tool is unavailable in local mode"),
  );
}

function registry(
  runtime: LocalWorkspaceRuntime,
  redact: (value: string) => string,
): ToolRegistry {
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
    preview: {
      createPreview: unavailable,
      runPreviewSmokeTest: unavailable,
    },
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

function gatewayWithRendererUpdates(input: {
  readonly gateway: SessionGateway;
  readonly database: Database.Database;
  readonly event: IpcMainInvokeEvent;
  readonly request: ChatStreamParams;
  readonly messageId: number;
}): SessionGateway {
  let content = "";
  let sentContent = "";
  return {
    async *stream(
      request: CompleteRequest,
      signal: AbortSignal,
    ): AsyncIterable<GatewayStreamEvent> {
      for await (const streamEvent of input.gateway.stream(request, signal)) {
        if (streamEvent.type === "text-delta") {
          content += streamEvent.text;
          input.database
            .prepare("UPDATE messages SET content = ? WHERE id = ?")
            .run(content, input.messageId);
          const patch = computeStreamingPatch(content, sentContent);
          if (patch !== null) {
            safeSend(input.event.sender, "chat:response:chunk", {
              chatId: input.request.chatId,
              streamId: input.request.streamId,
              streamingMessageId: input.messageId,
              streamingPatch: patch,
            } satisfies ChatStreamChunkPayload);
            sentContent = content;
          }
        }
        yield streamEvent;
      }
    },
  };
}

export function createLocalAgentStreamHandler(input: {
  readonly database: Database.Database;
  readonly platform: DesktopLocalAgentPlatform;
  readonly redact: (value: string) => string;
}): DesktopLocalAgentStreamHandler {
  return async (event, request, abortController, options) => {
    const project = LocalProjectSchema.parse(
      input.database
        .prepare<[number], unknown>(
          `SELECT apps.name, apps.path
             FROM chats
             JOIN apps ON apps.id = chats.app_id
            WHERE chats.id = ?`,
        )
        .get(request.chatId),
    );
    const accounting = LocalAgentSessionSchema.parse(
      await input.platform.ensureSession({
        chatId: request.chatId,
        localProjectName: project.name,
      }),
    );
    const runtime = new LocalWorkspaceRuntime(getDyadAppPath(project.path));
    const gateway = gatewayWithRendererUpdates({
      gateway: input.platform.gateway(accounting),
      database: input.database,
      event,
      request,
      messageId: options.placeholderMessageId,
    });
    const session = createLocalAgentSession({
      database: input.database,
      gateway,
      tools: registry(runtime, input.redact),
      runtime,
      redact: input.redact,
      prompts: {
        builder: options.systemPrompt,
        planner: options.systemPrompt,
        verifier: options.systemPrompt,
        summarizer: options.systemPrompt,
      },
    });
    const readOnly = options.readOnly === true || options.planModeOnly === true;
    const result = await session.run(
      {
        runId: accounting.runId,
        taskId: accounting.taskId,
        role: options.planModeOnly === true ? "planner" : "builder",
        mode: readOnly ? "ask" : "build",
        ...(options.planModeOnly === true
          ? {
              modeInstructions:
                "Inspect the project and return a plan without changing files.",
            }
          : {}),
        context: {
          role: options.planModeOnly === true ? "planner" : "builder",
          scope: {
            organizationId: accounting.organizationId,
            projectId: accounting.projectId,
            runId: accounting.runId,
          },
          taskId: accounting.taskId,
          tokenBudget: 100_000,
          tokenCount: Math.max(1, Math.ceil(request.prompt.length / 3)),
          sections: [
            {
              kind: "currentTask",
              content: request.prompt,
              tokenCount: Math.max(1, Math.ceil(request.prompt.length / 3)),
              sourceArtifactIds: [],
              sourceEventIds: [],
            },
          ],
        },
        tools: [...(readOnly ? READ_TOOLS : LOCAL_TOOLS)],
        budgets: {
          maxTurns: 25,
          maxTokens: 100_000,
          maxWallClockMs: 10 * 60_000,
        },
        control: {
          yieldAfterTool: false,
          redirect: {
            operationKey: continuationOperationKey(
              request.chatId,
              options.acceptedUserMessageId,
            ),
            instruction: request.prompt,
          },
        },
      },
      abortController.signal,
    );
    const commit = result.commits.at(-1);
    input.database
      .prepare(
        `UPDATE messages
            SET content = ?, commit_hash = ?
          WHERE id = ?`,
      )
      .run(result.summary, commit ?? null, options.placeholderMessageId);

    if (abortController.signal.aborted) return false;
    if (result.status !== "completed") {
      safeSend(event.sender, "chat:response:error", {
        chatId: request.chatId,
        streamId: request.streamId,
        error: result.summary || "The local agent did not complete.",
      } satisfies ChatStreamErrorPayload);
      safeSend(event.sender, "chat:response:end", {
        chatId: request.chatId,
        streamId: request.streamId,
        updatedFiles: false,
      } satisfies ChatStreamEndPayload);
      return false;
    }

    safeSend(event.sender, "chat:response:end", {
      chatId: request.chatId,
      streamId: request.streamId,
      updatedFiles: result.commits.length > 0,
    } satisfies ChatStreamEndPayload);
    return true;
  };
}
