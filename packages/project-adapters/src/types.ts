import { ExecutionContractSchema } from '@zapp/contracts';
import { z } from 'zod';

export const WorkspaceTargetQuestionSchema = z
  .object({
    kind: z.literal('workspace_target'),
    candidates: z.array(z.string().min(1)).min(2),
    prompt: z.literal('Which workspace package is the application target?'),
  })
  .strict();

export type WorkspaceTargetQuestion = z.infer<typeof WorkspaceTargetQuestionSchema>;

export const GenericNodeAnalysisSchema = z
  .object({
    contract: ExecutionContractSchema,
    openQuestions: z.array(WorkspaceTargetQuestionSchema),
  })
  .strict();

export type GenericNodeAnalysis = z.infer<typeof GenericNodeAnalysisSchema>;
