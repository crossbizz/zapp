import { createZappClient, type FetchImplementation } from "@zapp/api-client";
import {
  ClientFeatureFlagsResponseSchema,
  type ClientFeatureFlagsResponse,
} from "@zapp/config/flags";
import { z } from "zod";

import type { PlatformAuthSession } from "../auth/session";
import {
  CloudProjectOpenIntentSchema,
  CloudProjectPageSchema,
  CreateCloudProjectSchema,
  type CloudProjectOpenIntent,
  type CloudProjectPage,
  type CreateCloudProject,
} from "./model";

const BranchSchema = z
  .object({
    baseBranchId: z.string().min(1).nullable(),
    headCommitSha: z.string().min(1).nullable(),
    id: z.string().min(1),
    name: z.string().min(1),
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

const CreateProjectResponseSchema = z
  .object({
    branches: z.array(BranchSchema),
    environments: z.array(
      z
        .object({
          createdAt: z.string().min(1),
          databaseConnectionId: z.string().min(1).nullable(),
          deploymentProvider: z.string().min(1).nullable(),
          id: z.string().min(1),
          name: z.string().min(1),
          organizationId: z.string().min(1),
          projectId: z.string().min(1),
          type: z.string().min(1),
        })
        .strict(),
    ),
    project: CloudProjectPageSchema.shape.items.element,
    repository: z
      .object({
        defaultBranch: z.string().min(1),
        externalRepoRef: z.string().min(1).nullable(),
        id: z.string().min(1),
        internalRepoRef: z.string().min(1),
        organizationId: z.string().min(1),
        projectId: z.string().min(1),
        provider: z.string().min(1),
        syncPolicy: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const CreateRunResponseSchema = z
  .object({
    run: z
      .object({
        appType: z.enum(["web", "mobile"]),
        branchId: z.string().min(1).nullable(),
        completedAt: z.string().min(1).nullable(),
        id: z.string().min(1),
        mode: z.enum(["ask", "prototype", "build", "fix", "autonomous"]),
        model: z.string().min(1).nullable(),
        organizationId: z.string().min(1),
        projectId: z.string().min(1),
        startedAt: z.string().min(1),
        startedBy: z.string().min(1),
        status: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const ProjectDetailSchema = z
  .object({
    branches: z.array(BranchSchema),
    environments: CreateProjectResponseSchema.shape.environments,
    project: CloudProjectPageSchema.shape.items.element,
    repository: CreateProjectResponseSchema.shape.repository.nullable(),
  })
  .strict();

export class CloudDashboardUnavailableError extends Error {
  constructor() {
    super("Cloud projects are unavailable while signed out or offline.");
    this.name = "CloudDashboardUnavailableError";
  }
}

export interface CloudDashboardApi {
  getFeatureFlags(): Promise<ClientFeatureFlagsResponse>;
  listProjects(
    input: { readonly cursor?: string; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<CloudProjectPage>;
  createProject(input: CreateCloudProject): Promise<CloudProjectOpenIntent>;
  openProject(projectId: string): Promise<CloudProjectOpenIntent>;
}

function projectName(prompt: string): string {
  return prompt
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/[.!?]+$/gu, "")
    .slice(0, 80);
}

export function createCloudDashboardApi(options: {
  readonly auth: PlatformAuthSession;
  readonly baseUrl: string;
  readonly fetch?: FetchImplementation;
}): CloudDashboardApi {
  function context(): {
    readonly client: ReturnType<typeof createZappClient>;
    readonly organizationId: string;
  } {
    const state = options.auth.snapshot();
    const authorization = options.auth.authorizationHeader();
    if (
      state.status !== "authenticated" ||
      !state.cloudEnabled ||
      authorization === undefined ||
      !authorization.startsWith("Bearer ")
    ) {
      throw new CloudDashboardUnavailableError();
    }
    const token = authorization.slice("Bearer ".length);
    if (token.length === 0) throw new CloudDashboardUnavailableError();
    return {
      organizationId: state.selectedOrganizationId,
      client: createZappClient({
        baseUrl: options.baseUrl,
        getToken: () => token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    };
  }

  function headers(organizationId: string, idempotencyKey?: string) {
    return {
      "x-organization-id": organizationId,
      ...(idempotencyKey === undefined
        ? {}
        : { "idempotency-key": idempotencyKey }),
    };
  }

  return {
    async getFeatureFlags() {
      const { client, organizationId } = context();
      return ClientFeatureFlagsResponseSchema.parse(
        await client.request("/v1/feature-flags", {
          method: "GET",
          headers: headers(organizationId),
        }),
      );
    },

    async listProjects(input, signal) {
      const { client, organizationId } = context();
      const page = CloudProjectPageSchema.parse(
        await client.request("/v1/projects", {
          method: "GET",
          query: {
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
          headers: headers(organizationId),
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (
        page.items.some((project) => project.organizationId !== organizationId)
      ) {
        throw new CloudDashboardUnavailableError();
      }
      return page;
    },

    async createProject(unparsed) {
      const input = CreateCloudProjectSchema.parse(unparsed);
      const { client, organizationId } = context();
      const key = input.operationId;
      const created = CreateProjectResponseSchema.parse(
        await client.request("/v1/projects", {
          method: "POST",
          body: { name: projectName(input.prompt), sourceType: "prompt" },
          headers: headers(organizationId, `${key}:project`),
        }),
      );
      if (
        created.project.organizationId !== organizationId ||
        created.repository.organizationId !== organizationId ||
        created.repository.projectId !== created.project.id
      ) {
        throw new CloudDashboardUnavailableError();
      }
      const branch = created.branches.find(
        (candidate) =>
          candidate.name === created.repository.defaultBranch &&
          candidate.organizationId === organizationId &&
          candidate.projectId === created.project.id,
      );
      if (branch === undefined) throw new CloudDashboardUnavailableError();
      const run = CreateRunResponseSchema.parse(
        await client.request("/v1/projects/{projectId}/runs", {
          method: "POST",
          path: { projectId: created.project.id },
          body: {
            appType: "web",
            branchId: branch.id,
            mode: input.mode,
            prompt: input.prompt,
          },
          headers: headers(organizationId, `${key}:run`),
        }),
      );
      if (
        run.run.organizationId !== organizationId ||
        run.run.projectId !== created.project.id
      ) {
        throw new CloudDashboardUnavailableError();
      }
      return CloudProjectOpenIntentSchema.parse({
        mode: "cloud",
        projectId: created.project.id,
      });
    },

    async openProject(projectId) {
      const { client, organizationId } = context();
      const detail = ProjectDetailSchema.parse(
        await client.request("/v1/projects/{projectId}", {
          method: "GET",
          path: { projectId },
          headers: headers(organizationId),
        }),
      );
      if (
        detail.project.id !== projectId ||
        detail.project.organizationId !== organizationId
      ) {
        throw new CloudDashboardUnavailableError();
      }
      return CloudProjectOpenIntentSchema.parse({ mode: "cloud", projectId });
    },
  };
}
