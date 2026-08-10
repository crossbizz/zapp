import { RouteSchema } from '@zapp/contracts';
import type { WorkspaceRuntime } from '@zapp/workspace-runtime';
import ts from 'typescript';
import { z } from 'zod';

import {
  assertGeneratedSpecIndexClean,
  assertDeterministicPlaywright,
  commitGeneratedSpecPaths,
  type CommittedGeneratedPlaywrightSpec,
  ensureGeneratedSpecDirectory,
  findCommittedGeneratedSpec,
  withGeneratedSpecRepositoryLock,
} from './smoke.js';

const CriterionIdSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u)
  .max(64);
const OperationKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u);
const RelativeFileSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.split('/').includes('..') &&
      !value.includes('\0'),
    'must be a workspace-relative file path',
  );
const TestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const ComponentInventoryItemSchema = z
  .object({
    path: RelativeFileSchema,
    testIds: z.array(TestIdSchema).max(1_000).readonly(),
  })
  .strict()
  .readonly();
const AcceptanceGenerationInputSchema = z
  .object({
    operationKey: OperationKeySchema,
    criterionId: CriterionIdSchema,
    acceptanceCriterion: z.string().trim().min(1).max(20_000),
    routes: z.array(RouteSchema).max(10_000).readonly(),
    componentInventory: z.array(ComponentInventoryItemSchema).max(10_000).readonly(),
  })
  .strict()
  .readonly();
const RequiredTestIdSchema = z
  .object({ componentPath: RelativeFileSchema, testId: TestIdSchema })
  .strict();
const TestIdEditReceiptSchema = z
  .object({
    criterionId: CriterionIdSchema,
    componentPath: RelativeFileSchema,
    testId: TestIdSchema,
  })
  .strict()
  .readonly();
const BuilderGenerationSchema = z
  .object({
    source: z.string().min(1).max(1_000_000),
    requiredTestIds: z.array(RequiredTestIdSchema).min(1).max(1_000),
  })
  .strict();

type ParsedAcceptanceGenerationInput = z.output<typeof AcceptanceGenerationInputSchema>;
export type AcceptanceGenerationInput = z.input<typeof AcceptanceGenerationInputSchema>;

export interface AcceptanceBuilderSession {
  generate(input: { readonly role: 'builder'; readonly prompt: string }): Promise<unknown>;
}

export interface AcceptanceCodeEditTask {
  addTestId(input: {
    readonly criterionId: string;
    readonly componentPath: string;
    readonly testId: string;
  }): Promise<unknown>;
}

export interface AcceptanceSpecGenerator {
  generate(input: AcceptanceGenerationInput): Promise<CommittedGeneratedPlaywrightSpec>;
}

function promptFor(input: ParsedAcceptanceGenerationInput): string {
  return `You are the Builder-role acceptance-test generator.
Return one strict JSON object and no other text:
{"source":"<complete TypeScript Playwright spec>","requiredTestIds":[{"componentPath":"<workspace-relative component path>","testId":"<stable test id>"}]}

Rules:
- Import from @playwright/test and produce an executable spec for exactly the criterion below.
- Include the exact line // @zapp-criterion ${input.criterionId} for traceability.
- Prefix each test title with [${input.criterionId}].
- Select application controls with page.getByTestId(...); list every referenced test id.
- Do not use waitForTimeout, networkidle, arbitrary sleeps, or selectors invented outside the component inventory.
- Keep the spec tenant-safe and never include credentials, request bodies, or secret values.

Criterion:
${input.criterionId}: ${input.acceptanceCriterion}

Discovered routes:
${JSON.stringify(input.routes)}

Component inventory:
${JSON.stringify(input.componentInventory)}`;
}

const unstableSelectorMethods = new Set([
  '$',
  '$$',
  'frameLocator',
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByText',
  'getByTitle',
  'locator',
]);

function calledMethod(node: ts.CallExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  if (!ts.isElementAccessExpression(node.expression)) return undefined;
  const argument = node.expression.argumentExpression;
  return ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function assertCriterionMarker(source: string, criterionId: string): void {
  const expected = `// @zapp-criterion ${criterionId}`;
  if (!source.split(/\r?\n/u).some((line) => line.trim() === expected)) {
    throw new Error(`generated_spec_criterion_marker_missing:${criterionId}`);
  }
}

function referencedTestIds(source: string, criterionId: string): Set<string> {
  const file = ts.createSourceFile(
    'acceptance.spec.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ids = new Set<string>();
  const unstableSelectors = new Set<string>();
  let testCaseCount = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'test') {
        testCaseCount += 1;
        const title = node.arguments[0];
        if (
          title === undefined ||
          !ts.isStringLiteralLike(title) ||
          !title.text.startsWith(`[${criterionId}]`)
        ) {
          throw new Error(`generated_spec_criterion_title_missing:${criterionId}`);
        }
      }
      const method = calledMethod(node);
      if (method === 'getByTestId') {
        const first = node.arguments[0];
        if (first === undefined || !ts.isStringLiteralLike(first)) {
          throw new Error('generated_test_id_requires_literal');
        }
        ids.add(first.text);
      } else if (method !== undefined && unstableSelectorMethods.has(method)) {
        unstableSelectors.add(method);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (testCaseCount === 0) throw new Error(`generated_spec_criterion_title_missing:${criterionId}`);
  const firstUnstableSelector = [...unstableSelectors].sort()[0];
  if (firstUnstableSelector !== undefined) {
    throw new Error(`generated_selector_not_stable:${firstUnstableSelector}`);
  }
  return ids;
}

export function createAcceptanceSpecGenerator(dependencies: {
  readonly runtime: WorkspaceRuntime;
  readonly session: AcceptanceBuilderSession;
  readonly codeEdits: AcceptanceCodeEditTask;
}): AcceptanceSpecGenerator {
  return {
    async generate(rawInput) {
      const input = AcceptanceGenerationInputSchema.parse(rawInput);
      const path = `e2e/zapp/${input.criterionId.toLowerCase()}.spec.ts` as const;
      return withGeneratedSpecRepositoryLock(dependencies.runtime, async () => {
        const replay = await findCommittedGeneratedSpec(
          dependencies.runtime,
          input.operationKey,
          path,
        );
        if (replay !== undefined) return replay;
        await assertGeneratedSpecIndexClean(dependencies.runtime);
        const generated = BuilderGenerationSchema.parse(
          await dependencies.session.generate({ role: 'builder', prompt: promptFor(input) }),
        );
        assertDeterministicPlaywright(generated.source);
        assertCriterionMarker(generated.source, input.criterionId);

        const referenced = referencedTestIds(generated.source, input.criterionId);
        const inventory = new Map(
          input.componentInventory.map((component) => [component.path, new Set(component.testIds)]),
        );
        const missing = new Map<string, z.infer<typeof RequiredTestIdSchema>>();
        for (const requirement of generated.requiredTestIds) {
          const present = inventory.get(requirement.componentPath);
          if (present === undefined) {
            throw new Error(`generated_test_id_component_missing:${requirement.componentPath}`);
          }
          if (!referenced.has(requirement.testId)) {
            throw new Error(`generated_test_id_not_referenced:${requirement.testId}`);
          }
          if (!present.has(requirement.testId)) {
            missing.set(`${requirement.componentPath}\0${requirement.testId}`, requirement);
          }
        }
        if (referenced.size === 0) throw new Error('generated_spec_requires_test_ids');
        const declared = new Set(generated.requiredTestIds.map(({ testId }) => testId));
        for (const testId of referenced) {
          if (!declared.has(testId)) throw new Error(`generated_test_id_not_declared:${testId}`);
        }

        for (const requirement of missing.values()) {
          const request = {
            criterionId: input.criterionId,
            componentPath: requirement.componentPath,
            testId: requirement.testId,
          } as const;
          const receipt = TestIdEditReceiptSchema.parse(
            await dependencies.codeEdits.addTestId(request),
          );
          if (
            receipt.criterionId !== request.criterionId ||
            receipt.componentPath !== request.componentPath ||
            receipt.testId !== request.testId
          ) {
            throw new Error('generated_test_id_edit_receipt_mismatch');
          }
        }
        await ensureGeneratedSpecDirectory(dependencies.runtime);
        await dependencies.runtime.writeFile(path, new TextEncoder().encode(generated.source));
        return commitGeneratedSpecPaths(dependencies.runtime, {
          operationKey: input.operationKey,
          path,
          paths: [path, ...[...missing.values()].map(({ componentPath }) => componentPath)],
          subject: `test: add generated acceptance coverage for ${input.criterionId}`,
        });
      });
    },
  };
}
