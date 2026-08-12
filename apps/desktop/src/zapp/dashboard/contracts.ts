import { z } from "zod";
import { ClientFeatureFlagsResponseSchema } from "@zapp/config";

import { createClient, defineContract } from "@/ipc/contracts/core";

import {
  CloudProjectOpenIntentSchema,
  CloudProjectPageSchema,
  CreateCloudProjectSchema,
} from "./model";

export const dashboardContracts = {
  getFeatureFlags: defineContract({
    channel: "zapp-dashboard:get-feature-flags",
    input: z.object({}).strict(),
    output: ClientFeatureFlagsResponseSchema,
  }),
  listProjects: defineContract({
    channel: "zapp-dashboard:list-projects",
    input: z
      .object({
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100),
      })
      .strict(),
    output: CloudProjectPageSchema,
  }),
  createProject: defineContract({
    channel: "zapp-dashboard:create-project",
    input: CreateCloudProjectSchema,
    output: CloudProjectOpenIntentSchema,
  }),
  openProject: defineContract({
    channel: "zapp-dashboard:open-project",
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: CloudProjectOpenIntentSchema,
  }),
} as const;

export const dashboardClient = createClient(dashboardContracts);
