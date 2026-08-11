import type { ZappClient } from '@zapp/api-client';
import { z } from 'zod';

import {
  InterviewStateSchema,
  isInterviewExecutable,
} from './interview.js';
import {
  specificationContentEtag,
  SpecificationSchema,
  type Specification,
} from './schema.js';

export {
  createInterviewSession,
  INTERVIEW_CATEGORIES,
  InterviewCategorySchema,
  InterviewStateSchema,
  isInterviewExecutable,
  type InterviewCategory,
  type InterviewOption,
  type InterviewQuestion,
  type InterviewResponse,
  type InterviewSession,
  type InterviewState,
  type InterviewTurn,
} from './interview.js';
export {
  AcceptanceCriterionSchema,
  specificationContentEtag,
  SpecificationContentEtagSchema,
  SpecificationSchema,
  type AcceptanceCriterion,
  type Specification,
} from './schema.js';

export function buildSpecification(
  specificationValue: unknown,
  interviewStateValue: unknown,
): Specification {
  const interview = InterviewStateSchema.parse(interviewStateValue);
  if (!isInterviewExecutable(interview)) throw new Error('interview_not_executable');
  const specification = SpecificationSchema.parse(specificationValue);
  return SpecificationSchema.parse({
    ...specification,
    assumptions: [...new Set([...specification.assumptions, ...interview.assumptions])],
  });
}

const VersionedSpecificationSchema = z
  .object({
    id: z.string().min(1),
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(['draft', 'approved']),
    content: SpecificationSchema,
    createdBy: z.string().min(1),
    approvedBy: z.string().min(1).nullable(),
    approvedAt: z.string().datetime().nullable(),
  })
  .strict();
export type VersionedSpecification = z.infer<typeof VersionedSpecificationSchema>;

const SpecificationResponseSchema = z
  .object({ specification: VersionedSpecificationSchema })
  .strict();

const CreateAndApproveInputSchema = z
  .object({
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    specification: SpecificationSchema,
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,247}$/u),
  })
  .strict();

export interface ApprovedSpecificationVersion {
  readonly immutableVersionId: string;
  readonly specification: VersionedSpecification & {
    readonly status: 'approved';
    readonly approvedBy: string;
    readonly approvedAt: string;
  };
}

export async function createAndApproveSpecification(
  client: Pick<ZappClient, 'request'>,
  inputValue: z.input<typeof CreateAndApproveInputSchema>,
): Promise<ApprovedSpecificationVersion> {
  const input = CreateAndApproveInputSchema.parse(inputValue);
  const draftResponse = await client.request('/v1/projects/{projectId}/specifications', {
    method: 'POST',
    path: { projectId: input.projectId },
    headers: {
      'idempotency-key': `${input.idempotencyKey}:create`,
      'x-organization-id': input.organizationId,
    },
    body: input.specification,
  });
  const draft = SpecificationResponseSchema.parse(draftResponse).specification;
  assertSpecificationIdentity(draft, input.organizationId, input.projectId);

  const approvedResponse = await client.request(
    '/v1/projects/{projectId}/specifications/{version}/approve',
    {
      method: 'POST',
      path: { projectId: input.projectId, version: draft.version },
      headers: {
        'if-match': specificationContentEtag(draft.content),
        'idempotency-key': `${input.idempotencyKey}:approve`,
        'x-organization-id': input.organizationId,
      },
    },
  );
  const approved = SpecificationResponseSchema.parse(approvedResponse).specification;
  assertSpecificationIdentity(approved, input.organizationId, input.projectId);
  if (
    approved.id !== draft.id ||
    approved.version !== draft.version ||
    approved.status !== 'approved' ||
    approved.approvedBy === null ||
    approved.approvedAt === null
  ) {
    throw new Error('specification_approval_identity_mismatch');
  }
  if (specificationContentEtag(approved.content) !== specificationContentEtag(draft.content)) {
    throw new Error('specification_approval_content_mismatch');
  }

  return {
    immutableVersionId: approved.id,
    specification: {
      ...approved,
      status: 'approved',
      approvedBy: approved.approvedBy,
      approvedAt: approved.approvedAt,
    },
  };
}

function assertSpecificationIdentity(
  specification: VersionedSpecification,
  organizationId: string,
  projectId: string,
): void {
  if (
    specification.organizationId !== organizationId ||
    specification.projectId !== projectId
  ) {
    throw new Error('specification_tenant_identity_mismatch');
  }
}
