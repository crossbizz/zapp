import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createZappClient, type FetchImplementation } from "@zapp/api-client";
import {
  GatewayStreamEventSchema,
  LocalAgentSessionSchema,
  type LocalAgentSession,
} from "@zapp/contracts";
import type { CompleteRequest, GatewayStreamEvent } from "@zapp/model-gateway";
import type { SessionGateway } from "@zapp/orchestrator-worker/session";
import { z } from "zod";

const AuthSnapshotSchema = z
  .object({
    status: z.literal("authenticated"),
    selectedOrganizationId: z.string().min(1),
    cloudEnabled: z.literal(true),
  })
  .passthrough();

const StoredSessionIdSchema = z
  .object({
    session_id: z.string().uuid(),
    local_project_name: z.string().min(1),
  })
  .strict();

export interface LocalAgentPlatformAuth {
  snapshot(): unknown;
  authorizationHeader(): string | undefined;
}

export interface DesktopLocalAgentPlatformOptions {
  readonly auth: LocalAgentPlatformAuth;
  readonly baseUrl: string;
  readonly database: Database.Database;
  readonly fetch?: FetchImplementation;
  readonly randomUUID?: () => string;
}

function completionBody(request: CompleteRequest) {
  const {
    organizationId: _organizationId,
    projectId: _projectId,
    runId: _runId,
    taskId: _taskId,
    ...body
  } = request;
  return body;
}

export function createDesktopLocalAgentPlatform(
  options: DesktopLocalAgentPlatformOptions,
) {
  const client = createZappClient({
    baseUrl: options.baseUrl,
    getToken: () => {
      const authorization = options.auth.authorizationHeader();
      if (authorization?.startsWith("Bearer ") !== true) {
        throw new Error(
          "Local agent requires an authenticated platform session",
        );
      }
      const token = authorization.slice("Bearer ".length);
      if (token.length === 0) {
        throw new Error(
          "Local agent requires an authenticated platform session",
        );
      }
      return token;
    },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  function sessionFor(
    chatId: number,
    localProjectName: string,
  ): { readonly sessionId: string; readonly localProjectName: string } {
    const insert = options.database.transaction(() => {
      const existing = StoredSessionIdSchema.safeParse(
        options.database
          .prepare<[number], unknown>(
            `SELECT session_id, local_project_name
               FROM zapp_local_agent_chat_sessions
              WHERE chat_id = ?`,
          )
          .get(chatId),
      );
      if (existing.success) {
        return {
          sessionId: existing.data.session_id,
          localProjectName: existing.data.local_project_name,
        };
      }
      const sessionId = z
        .string()
        .uuid()
        .parse((options.randomUUID ?? randomUUID)());
      options.database
        .prepare(
          `INSERT INTO zapp_local_agent_chat_sessions
             (chat_id, session_id, local_project_name, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(chatId, sessionId, localProjectName, Date.now());
      return { sessionId, localProjectName };
    });
    return insert();
  }

  return {
    async ensureSession(input: {
      readonly chatId: number;
      readonly localProjectName: string;
    }): Promise<LocalAgentSession> {
      const auth = AuthSnapshotSchema.parse(options.auth.snapshot());
      const durable = sessionFor(input.chatId, input.localProjectName);
      const response = await client.request("/v1/local-agent/sessions", {
        method: "POST",
        body: durable,
        headers: {
          "x-organization-id": auth.selectedOrganizationId,
          "idempotency-key": `desktop-local-agent:${durable.sessionId}`,
        },
      });
      const session = LocalAgentSessionSchema.parse(response.session);
      if (session.organizationId !== auth.selectedOrganizationId) {
        throw new Error(
          "Local agent session tenant does not match the selected organization",
        );
      }
      return session;
    },

    gateway(sessionInput: unknown): SessionGateway {
      const session = LocalAgentSessionSchema.parse(sessionInput);
      return {
        async *stream(
          request: CompleteRequest,
          signal: AbortSignal,
        ): AsyncIterable<GatewayStreamEvent> {
          if (
            request.organizationId !== session.organizationId ||
            request.projectId !== session.projectId ||
            request.runId !== session.runId ||
            request.taskId !== session.taskId
          ) {
            throw new Error("Local completion accounting identity changed");
          }
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const buffered: GatewayStreamEvent[] = [];
            try {
              for await (const event of client.streamLocalAgentCompletion(
                session.sessionId,
                completionBody(request),
                { organizationId: session.organizationId, signal },
              )) {
                buffered.push(GatewayStreamEventSchema.parse(event));
              }
              yield* buffered;
              return;
            } catch (error) {
              if (signal.aborted) throw signal.reason;
              if (attempt === 1) throw error;
            }
          }
        },
      };
    },
  };
}
