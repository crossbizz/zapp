import { z } from 'zod';

import { PageSchema } from './api.js';
import { AgentEventObjectSchema } from './events.js';
import { idSchema } from './id-schema.js';

export const ConversationSchema = z
  .object({
    id: idSchema('conv'),
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    createdBy: idSchema('user'),
    title: z.string().trim().min(1).max(160),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const ConversationSummarySchema = ConversationSchema.pick({
  id: true,
  projectId: true,
  title: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({
    latestRun: z
      .object({
        id: idSchema('run'),
        status: z.string().trim().min(1).max(64),
      })
      .strict(),
    runCount: z.number().int().positive(),
  })
  .strict();

export const ConversationEventSchema = z
  .object({
    runNumber: z.number().int().positive(),
    event: AgentEventObjectSchema,
  })
  .strict();

export const ConversationPageSchema = PageSchema(ConversationSummarySchema);
export const ConversationEventPageSchema = PageSchema(ConversationEventSchema);

export type Conversation = z.infer<typeof ConversationSchema>;
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export type ConversationPage = z.infer<typeof ConversationPageSchema>;
export type ConversationEventPage = z.infer<typeof ConversationEventPageSchema>;
