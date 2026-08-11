import { z } from 'zod';

export const INTERVIEW_CATEGORIES = [
  'targetUsers',
  'userRoles',
  'coreWorkflows',
  'dataEntities',
  'permissions',
  'authentication',
  'billing',
  'integrations',
  'platformPriority',
  'productionBehavior',
  'criticalWorkflows',
  'dataSensitivity',
  'deploymentOwnership',
] as const;

export const InterviewCategorySchema = z.enum(INTERVIEW_CATEGORIES);
export type InterviewCategory = z.infer<typeof InterviewCategorySchema>;

const ConsequenceSchema = z
  .object({
    architecture: z.number().int().min(0).max(3),
    scope: z.number().int().min(0).max(3),
    risk: z.number().int().min(0).max(3),
    acceptanceCriteria: z.number().int().min(0).max(3),
  })
  .strict();

const InterviewOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(500),
    tradeoff: z.string().trim().min(1).max(2_000),
    recommended: z.boolean(),
  })
  .strict();
export type InterviewOption = z.infer<typeof InterviewOptionSchema>;

const InterviewQuestionDefinitionSchema = z
  .object({
    category: InterviewCategorySchema,
    question: z.string().trim().min(1).max(2_000),
    consequence: ConsequenceSchema,
    options: z.array(InterviewOptionSchema).min(2).max(5),
  })
  .strict()
  .superRefine((definition, context) => {
    if (definition.options.filter(({ recommended }) => recommended).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interview_question_requires_one_recommendation',
        path: ['options'],
      });
    }
  });

export interface InterviewQuestion extends z.infer<typeof InterviewQuestionDefinitionSchema> {
  readonly consequenceScore: number;
}

const question = (
  definition: z.input<typeof InterviewQuestionDefinitionSchema>,
): z.infer<typeof InterviewQuestionDefinitionSchema> =>
  InterviewQuestionDefinitionSchema.parse(definition);

const INTERVIEW_QUESTIONS: readonly z.infer<typeof InterviewQuestionDefinitionSchema>[] = [
  question({
    category: 'targetUsers',
    question: 'Who is the primary user for the first releasable workflow?',
    consequence: { architecture: 1, scope: 3, risk: 1, acceptanceCriteria: 2 },
    options: [
      {
        label: 'One narrow professional persona',
        tradeoff: 'Fastest path to precise workflows, but secondary personas wait.',
        recommended: true,
      },
      {
        label: 'Several equal-priority personas',
        tradeoff: 'Broader reach, but navigation and requirements become more complex.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'userRoles',
    question: 'Which user-role model must the first release support?',
    consequence: { architecture: 2, scope: 2, risk: 2, acceptanceCriteria: 2 },
    options: [
      {
        label: 'Owner, builder, and viewer',
        tradeoff: 'Covers the common collaboration boundary with a modest policy surface.',
        recommended: true,
      },
      {
        label: 'Custom roles and permissions',
        tradeoff: 'More flexible, but adds policy editing, validation, and migration work.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'coreWorkflows',
    question: 'Which workflow must work end to end before the product is useful?',
    consequence: { architecture: 2, scope: 3, risk: 2, acceptanceCriteria: 3 },
    options: [
      {
        label: 'One explicit critical workflow',
        tradeoff: 'Creates a sharp release gate while deferring less important paths.',
        recommended: true,
      },
      {
        label: 'A broad workflow suite',
        tradeoff: 'Covers more scenarios, but raises build and verification scope substantially.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'dataEntities',
    question: 'What is the smallest durable data model required for the critical workflow?',
    consequence: { architecture: 3, scope: 2, risk: 2, acceptanceCriteria: 2 },
    options: [
      {
        label: 'Only entities used by the critical workflow',
        tradeoff: 'Keeps migrations small, but later workflows may add compatible schema changes.',
        recommended: true,
      },
      {
        label: 'The anticipated full domain model',
        tradeoff: 'May reduce later migrations, but risks speculative complexity now.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'permissions',
    question: 'Where must authorization be enforced?',
    consequence: { architecture: 3, scope: 1, risk: 3, acceptanceCriteria: 3 },
    options: [
      {
        label: 'Server-side on every tenant resource',
        tradeoff: 'Strong isolation with explicit policy tests; UI checks remain convenience only.',
        recommended: true,
      },
      {
        label: 'Shared resources with client-side visibility rules',
        tradeoff: 'Simpler server code, but does not provide an acceptable isolation boundary.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'authentication',
    question: 'How should users authenticate in the first production release?',
    consequence: { architecture: 3, scope: 2, risk: 3, acceptanceCriteria: 2 },
    options: [
      {
        label: 'Managed identity provider',
        tradeoff: 'Reduces credential risk, but introduces a vendor integration and test project.',
        recommended: true,
      },
      {
        label: 'Application-managed credentials',
        tradeoff: 'Avoids an external dependency, but creates a large security and recovery burden.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'billing',
    question: 'Does the first release need paid-plan enforcement?',
    consequence: { architecture: 2, scope: 3, risk: 2, acceptanceCriteria: 2 },
    options: [
      {
        label: 'No billing in the first release',
        tradeoff: 'Shortens launch scope, but monetization and entitlement work follow later.',
        recommended: true,
      },
      {
        label: 'Usage-based paid plans at launch',
        tradeoff: 'Supports revenue immediately, but adds metering, webhooks, and reconciliation.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'integrations',
    question: 'Which external systems are required for the critical workflow?',
    consequence: { architecture: 3, scope: 3, risk: 2, acceptanceCriteria: 2 },
    options: [
      {
        label: 'Only launch-blocking integrations',
        tradeoff: 'Limits failure modes while preserving the required workflow.',
        recommended: true,
      },
      {
        label: 'All requested integrations',
        tradeoff: 'Improves breadth, but multiplies credentials, retries, and provider testing.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'platformPriority',
    question: 'Which client platform is authoritative for the first release?',
    consequence: { architecture: 2, scope: 3, risk: 1, acceptanceCriteria: 2 },
    options: [
      {
        label: 'Responsive web first',
        tradeoff: 'Maximizes reach with one client, but defers native-only capabilities.',
        recommended: true,
      },
      {
        label: 'Web and native mobile together',
        tradeoff: 'Covers more devices, but roughly doubles client delivery and QA surfaces.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'productionBehavior',
    question: 'What production guarantees are mandatory at launch?',
    consequence: { architecture: 3, scope: 2, risk: 3, acceptanceCriteria: 3 },
    options: [
      {
        label: 'Explicit reliability, recovery, and observability criteria',
        tradeoff: 'Adds operational work, but makes production readiness verifiable.',
        recommended: true,
      },
      {
        label: 'Best-effort prototype behavior',
        tradeoff: 'Launches sooner, but is not suitable for production-critical workflows.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'criticalWorkflows',
    question: 'Which workflows must be protected by release-blocking regression tests?',
    consequence: { architecture: 1, scope: 2, risk: 3, acceptanceCriteria: 3 },
    options: [
      {
        label: 'The primary journey plus destructive actions',
        tradeoff: 'Protects the highest-consequence paths without blocking on exhaustive coverage.',
        recommended: true,
      },
      {
        label: 'Every visible interaction',
        tradeoff: 'Offers broad coverage, but creates a slower and more brittle release gate.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'dataSensitivity',
    question: 'What is the most sensitive data the product will handle?',
    consequence: { architecture: 3, scope: 1, risk: 3, acceptanceCriteria: 2 },
    options: [
      {
        label: 'Business-confidential data, no regulated records',
        tradeoff: 'Still requires tenant isolation and encryption, but avoids regulated-data scope.',
        recommended: true,
      },
      {
        label: 'Regulated or highly sensitive records',
        tradeoff: 'Requires stricter retention, access, audit, and compliance controls.',
        recommended: false,
      },
    ],
  }),
  question({
    category: 'deploymentOwnership',
    question: 'Who owns production deployment and rollback?',
    consequence: { architecture: 2, scope: 2, risk: 3, acceptanceCriteria: 2 },
    options: [
      {
        label: 'The customer approves; the platform executes',
        tradeoff: 'Keeps a human release gate while allowing repeatable automation.',
        recommended: true,
      },
      {
        label: 'The customer operates deployment directly',
        tradeoff: 'Provides maximum control, but requires handoff tooling and customer operations skill.',
        recommended: false,
      },
    ],
  }),
];

const ResolutionSchema = z
  .object({
    decision: z.string().trim().min(1).max(20_000),
    source: z.enum(['user', 'assumption']),
  })
  .strict();

export const InterviewStateSchema = z
  .object({
    resolutions: z.record(InterviewCategorySchema, ResolutionSchema),
    assumptions: z.array(z.string().trim().min(1).max(20_000)).max(INTERVIEW_CATEGORIES.length),
    pendingCategories: z.array(InterviewCategorySchema).max(3),
  })
  .strict()
  .superRefine((state, context) => {
    if (new Set(state.pendingCategories).size !== state.pendingCategories.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'interview_pending_category_duplicate',
        path: ['pendingCategories'],
      });
    }
    for (const [index, category] of state.pendingCategories.entries()) {
      if (state.resolutions[category] !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'interview_pending_category_already_resolved',
          path: ['pendingCategories', index],
        });
      }
    }
  });
export type InterviewState = z.infer<typeof InterviewStateSchema>;

const InterviewResponseSchema = z
  .object({
    category: InterviewCategorySchema,
    answer: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type InterviewResponse = z.infer<typeof InterviewResponseSchema>;

export type InterviewTurn =
  | { readonly status: 'questions'; readonly questions: readonly InterviewQuestion[] }
  | { readonly status: 'complete'; readonly questions: readonly [] };

export interface InterviewSession {
  readonly state: InterviewState;
  nextTurn(): InterviewTurn;
  respond(responses: readonly InterviewResponse[]): InterviewState;
}

const consequenceScore = (
  consequence: z.infer<typeof ConsequenceSchema>,
): number =>
  consequence.architecture +
  consequence.scope +
  consequence.risk +
  consequence.acceptanceCriteria;

const questionFor = (category: InterviewCategory): InterviewQuestion => {
  const definition = INTERVIEW_QUESTIONS.find((candidate) => candidate.category === category);
  if (definition === undefined) throw new Error(`interview_question_missing:${category}`);
  return { ...definition, consequenceScore: consequenceScore(definition.consequence) };
};

const invalidInterviewState = (message: string, path: readonly PropertyKey[]): z.ZodError =>
  new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      message,
      path: [...path].map(String),
    },
  ]);

const delegated = (answer: string): boolean => {
  const normalized = answer.trim().toLowerCase().replace(/[.!]+$/u, '');
  return normalized === 'you decide' || normalized === 'decide for me';
};

class ConsequentialInterviewSession implements InterviewSession {
  private current: InterviewState;

  constructor(initialState?: unknown) {
    this.current = InterviewStateSchema.parse(
      initialState ?? { resolutions: {}, assumptions: [], pendingCategories: [] },
    );
  }

  get state(): InterviewState {
    return InterviewStateSchema.parse(this.current);
  }

  nextTurn(): InterviewTurn {
    if (isInterviewExecutable(this.current)) return { status: 'complete', questions: [] };

    if (this.current.pendingCategories.length === 0) {
      const unresolved = INTERVIEW_CATEGORIES.filter(
        (category) => this.current.resolutions[category] === undefined,
      )
        .map(questionFor)
        .sort((left, right) => right.consequenceScore - left.consequenceScore)
        .slice(0, 3);
      this.current = InterviewStateSchema.parse({
        ...this.current,
        pendingCategories: unresolved.map(({ category }) => category),
      });
    }

    return {
      status: 'questions',
      questions: this.current.pendingCategories.map(questionFor),
    };
  }

  respond(responseValues: readonly InterviewResponse[]): InterviewState {
    const responses = z
      .array(InterviewResponseSchema)
      .min(1)
      .max(3)
      .parse(responseValues);
    const responseCategories = responses.map(({ category }) => category);
    if (new Set(responseCategories).size !== responseCategories.length) {
      throw invalidInterviewState('interview_response_category_duplicate', ['responses']);
    }
    const pending = new Set(this.current.pendingCategories);
    for (const [index, response] of responses.entries()) {
      if (!pending.has(response.category)) {
        throw invalidInterviewState('interview_response_not_pending', [
          'responses',
          index,
          'category',
        ]);
      }
    }

    const resolutions = { ...this.current.resolutions };
    const assumptions = [...this.current.assumptions];
    for (const response of responses) {
      if (delegated(response.answer)) {
        const selected = questionFor(response.category).options.find(({ recommended }) => recommended);
        if (selected === undefined) {
          throw new Error(`interview_recommendation_missing:${response.category}`);
        }
        resolutions[response.category] = { decision: selected.label, source: 'assumption' };
        assumptions.push(`${response.category}: ${selected.label} (delegated by user)`);
      } else {
        resolutions[response.category] = { decision: response.answer, source: 'user' };
      }
    }

    this.current = InterviewStateSchema.parse({
      resolutions,
      assumptions,
      pendingCategories: this.current.pendingCategories.filter(
        (category) => !responseCategories.includes(category),
      ),
    });
    return this.state;
  }
}

export function createInterviewSession(initialState?: unknown): InterviewSession {
  return new ConsequentialInterviewSession(initialState);
}

export function isInterviewExecutable(stateValue: unknown): boolean {
  const state = InterviewStateSchema.parse(stateValue);
  return INTERVIEW_CATEGORIES.every((category) => state.resolutions[category] !== undefined);
}
