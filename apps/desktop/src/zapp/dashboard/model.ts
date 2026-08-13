import { z } from "zod";

export const CloudProjectSchema = z
  .object({
    archivedAt: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    createdBy: z.string().min(1),
    description: z.string().nullable(),
    id: z.string().min(1),
    name: z.string().min(1),
    organizationId: z.string().min(1),
    slug: z.string().min(1),
    sourceType: z.string().min(1),
    supportLevel: z.enum(["compatible", "verified", "managed"]),
  })
  .strict();

export type CloudProject = z.infer<typeof CloudProjectSchema>;

export const CloudProjectPageSchema = z
  .object({
    items: z.array(CloudProjectSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type CloudProjectPage = z.infer<typeof CloudProjectPageSchema>;

export const CloudProjectOpenIntentSchema = z
  .object({
    mode: z.literal("cloud"),
    projectId: z.string().min(1),
  })
  .strict();

export type CloudProjectOpenIntent = z.infer<
  typeof CloudProjectOpenIntentSchema
>;

export const CreateCloudProjectSchema = z
  .object({
    operationId: z.uuid(),
    prompt: z.string().trim().min(10).max(20_000),
    mode: z.enum(["ask", "prototype", "build", "autonomous"]),
  })
  .strict();

export type CreateCloudProject = z.infer<typeof CreateCloudProjectSchema>;

export interface LocalProjectSummary {
  readonly id: number;
  readonly name: string;
  readonly path: string;
}
