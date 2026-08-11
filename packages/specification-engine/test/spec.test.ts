import type { ZappClient } from '@zapp/api-client';
import { describe, expect, test } from 'vitest';

import {
  buildSpecification,
  createAndApproveSpecification,
  createInterviewSession,
  INTERVIEW_CATEGORIES,
  isInterviewExecutable,
  specificationContentEtag,
  SpecificationSchema,
  type Specification,
} from '../src/spec.js';

const SPECIFICATION = {
  problem: 'Release requirements are scattered across chat messages.',
  targetUsers: ['Product managers', 'Engineers'],
  goals: ['Produce one approved, executable delivery contract'],
  nonGoals: ['Generate implementation code during the interview'],
  journeys: ['A product manager answers questions and approves the resulting specification'],
  pagesRoutes: ['GET /v1/projects/:projectId/specifications/:version'],
  rolesPermissions: ['Builders may draft specifications; project members may read them'],
  dataModel: ['Versioned specification with immutable approval metadata'],
  integrations: ['zapp.build public API'],
  functionalRequirements: ['Ask only consequential unresolved questions'],
  nonfunctionalRequirements: ['Every mutating API call is idempotent'],
  acceptanceCriteria: [
    {
      id: 'AC-1',
      text: 'The interview stops once every critical category is resolved or assumed.',
      priority: 'critical',
      criticalFlow: true,
    },
  ],
  assumptions: ['The project already exists.'],
  risks: ['A delegated decision may need revision before approval.'],
  definitionOfDone: ['The approved specification has an immutable version identifier.'],
} satisfies Specification;

describe('SpecificationSchema', () => {
  test('round-trips the complete PRD 12.2 artifact', () => {
    expect(SpecificationSchema.parse(SPECIFICATION)).toEqual(SPECIFICATION);
  });
});

describe('consequential-question interview', () => {
  test('asks at most three option-rich questions per turn and stops when executable', () => {
    const interview = createInterviewSession();
    let turns = 0;

    while (!isInterviewExecutable(interview.state)) {
      const turn = interview.nextTurn();
      expect(turn.status).toBe('questions');
      expect(turn.questions).toHaveLength(Math.min(3, INTERVIEW_CATEGORIES.length - turns * 3));
      expect(turn.questions.every(({ options }) => options.length >= 2)).toBe(true);
      expect(
        turn.questions.every(({ options }) =>
          options.every(({ tradeoff }) => tradeoff.trim().length > 0),
        ),
      ).toBe(true);
      expect(turn.questions.map(({ consequenceScore }) => consequenceScore)).toEqual(
        [...turn.questions.map(({ consequenceScore }) => consequenceScore)].sort((a, b) => b - a),
      );

      interview.respond(
        turn.questions.map((question) => ({
          category: question.category,
          answer: question.options[0]?.label ?? 'Resolved',
        })),
      );
      turns += 1;
    }

    expect(Object.keys(interview.state.resolutions).sort()).toEqual([...INTERVIEW_CATEGORIES].sort());
    expect(interview.nextTurn()).toEqual({ status: 'complete', questions: [] });
  });

  test('records a concrete assumption when the user delegates with "you decide"', () => {
    const interview = createInterviewSession();
    const turn = interview.nextTurn();
    const question = turn.questions[0];
    expect(question).toBeDefined();
    if (question === undefined) throw new Error('Expected an interview question.');
    const recommended = question.options.find(({ recommended }) => recommended);
    expect(recommended).toBeDefined();

    interview.respond([{ category: question.category, answer: 'you decide' }]);

    expect(interview.state.resolutions[question.category]).toMatchObject({
      source: 'assumption',
      decision: recommended?.label,
    });
    expect(interview.state.assumptions).toContain(
      `${question.category}: ${recommended?.label ?? ''} (delegated by user)`,
    );
  });

  test('carries delegated decisions into the executable specification', () => {
    const interview = createInterviewSession();
    let delegated = false;
    while (!isInterviewExecutable(interview.state)) {
      const turn = interview.nextTurn();
      interview.respond(
        turn.questions.map((question) => {
          if (!delegated) {
            delegated = true;
            return { category: question.category, answer: 'you decide' };
          }
          return { category: question.category, answer: question.options[0]?.label ?? 'Resolved' };
        }),
      );
    }

    const specification = buildSpecification(SPECIFICATION, interview.state);
    expect(specification.assumptions).toEqual([
      ...SPECIFICATION.assumptions,
      ...interview.state.assumptions,
    ]);
  });
});

describe('CP-10 specification approval integration', () => {
  test('rejects base idempotency keys that cannot remain valid after suffixing', async () => {
    const client = {
      request: () => Promise.reject(new Error('The API must not be called.')),
    } as unknown as Pick<ZappClient, 'request'>;

    await expect(
      createAndApproveSpecification(client, {
        organizationId: 'org_01JAR16ORGANIZATION00001',
        projectId: 'proj_01JAR16PROJECT000000001',
        specification: SPECIFICATION,
        idempotencyKey: 'x'.repeat(248),
      }),
    ).rejects.toThrow();
  });

  test('creates and approves one version through the generated public API client', async () => {
    const calls: Array<{ path: string; options: unknown }> = [];
    const draft = {
      id: 'spec_01JAR16SPECIFICATION000001',
      organizationId: 'org_01JAR16ORGANIZATION00001',
      projectId: 'proj_01JAR16PROJECT000000001',
      version: 3,
      status: 'draft' as const,
      content: SPECIFICATION,
      createdBy: 'usr_01JAR16OWNER00000000001',
      approvedBy: null,
      approvedAt: null,
    };
    const approved = {
      ...draft,
      status: 'approved' as const,
      approvedBy: draft.createdBy,
      approvedAt: '2026-08-10T20:00:00.000Z',
    };
    const client = {
      request: (path: string, options: unknown) => {
        calls.push({ path, options });
        return Promise.resolve({ specification: calls.length === 1 ? draft : approved });
      },
    } as unknown as Pick<ZappClient, 'request'>;

    const result = await createAndApproveSpecification(client, {
      organizationId: draft.organizationId,
      projectId: draft.projectId,
      specification: SPECIFICATION,
      idempotencyKey: 'run_ar16:specification',
    });

    expect(calls).toEqual([
      {
        path: '/v1/projects/{projectId}/specifications',
        options: {
          method: 'POST',
          path: { projectId: draft.projectId },
          headers: {
            'idempotency-key': 'run_ar16:specification:create',
            'x-organization-id': draft.organizationId,
          },
          body: SPECIFICATION,
        },
      },
      {
        path: '/v1/projects/{projectId}/specifications/{version}/approve',
        options: {
          method: 'POST',
          path: { projectId: draft.projectId, version: draft.version },
          headers: {
            'if-match': specificationContentEtag(SPECIFICATION),
            'idempotency-key': 'run_ar16:specification:approve',
            'x-organization-id': draft.organizationId,
          },
        },
      },
    ]);
    expect(result).toEqual({ immutableVersionId: approved.id, specification: approved });
  });

  test('rejects an approval response whose content changed after draft creation', async () => {
    const draft = {
      id: 'spec_01JAR16SPECIFICATION000002',
      organizationId: 'org_01JAR16ORGANIZATION00001',
      projectId: 'proj_01JAR16PROJECT000000001',
      version: 4,
      status: 'draft' as const,
      content: SPECIFICATION,
      createdBy: 'usr_01JAR16OWNER00000000001',
      approvedBy: null,
      approvedAt: null,
    };
    const changed = {
      ...draft,
      status: 'approved' as const,
      content: { ...SPECIFICATION, goals: ['A concurrent edit changed the approved scope.'] },
      approvedBy: draft.createdBy,
      approvedAt: '2026-08-10T20:00:00.000Z',
    };
    let call = 0;
    const client = {
      request: () => {
        call += 1;
        return Promise.resolve({ specification: call === 1 ? draft : changed });
      },
    } as unknown as Pick<ZappClient, 'request'>;

    await expect(
      createAndApproveSpecification(client, {
        organizationId: draft.organizationId,
        projectId: draft.projectId,
        specification: SPECIFICATION,
        idempotencyKey: 'run_ar16:specification',
      }),
    ).rejects.toThrow('specification_approval_content_mismatch');
  });
});
