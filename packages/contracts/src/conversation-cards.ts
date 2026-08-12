import { z } from 'zod';

import { RunApprovalKindSchema } from './budget-approval.js';
import { idSchema } from './id-schema.js';

export const ConversationCardIdSchema = z
  .string()
  .regex(/^card_[A-Za-z0-9._:-]{1,240}$/u);

const QuestionOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(500),
    tradeoff: z.string().trim().min(1).max(2_000),
    recommended: z.boolean(),
  })
  .strict();

const QuestionSchema = z
  .object({
    questionId: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(2_000),
    options: z.array(QuestionOptionSchema).min(2).max(5),
  })
  .strict();

const CardIdentity = { version: z.literal(1), cardId: ConversationCardIdSchema } as const;

export const ConversationCardSchema = z.discriminatedUnion('kind', [
  z.object({
    ...CardIdentity,
    kind: z.literal('question'),
    questions: z.array(QuestionSchema).min(1).max(3),
  }).strict(),
  z.object({
    ...CardIdentity,
    kind: z.literal('specification'),
    approvalId: idSchema('appr'),
    artifactId: z.string().min(1).max(512),
    artifactVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    ...CardIdentity,
    kind: z.literal('plan'),
    approvalId: idSchema('appr'),
    artifactId: idSchema('art'),
    approvalKind: z.enum(['plan', 'plan_diff']),
  }).strict(),
  z.object({
    ...CardIdentity,
    kind: z.literal('approval'),
    approvalId: idSchema('appr'),
    approvalKind: RunApprovalKindSchema.exclude(['specification', 'plan', 'plan_diff']),
  }).strict(),
]);
export type ConversationCard = z.infer<typeof ConversationCardSchema>;

const QuestionAnswerSchema = z
  .object({
    questionId: z.string().trim().min(1).max(160),
    answer: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const ConversationCardResponseSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('question_answers'),
    cardId: ConversationCardIdSchema,
    answers: z.array(QuestionAnswerSchema).min(1).max(3),
  })
  .strict()
  .superRefine((response, context) => {
    const ids = response.answers.map(({ questionId }) => questionId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'conversation_card_answer_duplicate',
        path: ['answers'],
      });
    }
  });
export type ConversationCardResponse = z.infer<typeof ConversationCardResponseSchema>;

export const ConversationCardEventPayloadSchema = z
  .object({ card: ConversationCardSchema })
  .strict();
export const ConversationResponseEventPayloadSchema = z
  .object({ response: ConversationCardResponseSchema })
  .strict();
