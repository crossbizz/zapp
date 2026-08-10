import { createHash } from 'node:crypto';

import { idSchema } from '@zapp/contracts';
import {
  CompleteRequestSchema,
  GatewayStreamEventSchema,
  type ChatMessage,
  type CompleteRequest,
  type GatewayStreamEvent,
  type JsonValue,
  type NeutralTool,
} from '@zapp/model-gateway';
import { z } from 'zod';

import {
  BrowserPrimitiveObservationSchema,
  type BrowserAgentDriver,
  type BrowserPrimitiveObservation,
  type BrowserPrimitiveSource,
} from './driver.js';

export const BROWSER_AGENT_FLOW_BUDGET_MS = 15 * 60 * 1_000;
const MAX_AGENT_TURNS = 32;
const MAX_OUTPUT_TOKENS = 2_048;

export const BROWSER_AGENT_TOOL_NAMES = [
  'snapshotAccessibilityTree',
  'listInteractive',
  'click',
  'fill',
  'expectVisibleText',
  'readConsole',
  'readFailedRequests',
  'screenshot',
] as const;
type BrowserAgentToolName = (typeof BROWSER_AGENT_TOOL_NAMES)[number];

const BrowserFlowSchema = z
  .object({
    flow: z.string().trim().min(1).max(256),
    journey: z.array(z.string().trim().min(1).max(2_048)).min(1).max(100),
  })
  .strict();
export type BrowserFlow = z.infer<typeof BrowserFlowSchema>;

export const BrowserAgentSessionInputSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    runId: idSchema('run'),
    taskId: idSchema('task'),
    flows: z.array(BrowserFlowSchema).min(1).max(50),
  })
  .strict();
export type BrowserAgentSessionInput = z.infer<typeof BrowserAgentSessionInputSchema>;

const BrowserAgentFlowInputSchema = BrowserAgentSessionInputSchema.extend({
  flowIndex: z.number().int().nonnegative(),
  flow: BrowserFlowSchema,
}).strict();
type BrowserAgentFlowInput = z.infer<typeof BrowserAgentFlowInputSchema>;

const EvidenceRecordInputSchema = z
  .object({
    flow: z.string().min(1).max(256),
    stepIndex: z.number().int().nonnegative(),
    source: z.enum(['dom', 'accessibility', 'network', 'console', 'screenshot']),
    label: z.string().min(1).max(256),
    contentType: z.enum(['application/json', 'image/png']),
    body: z.instanceof(Uint8Array),
  })
  .strict();
export type BrowserAgentEvidenceRecord = z.infer<typeof EvidenceRecordInputSchema>;

export interface BrowserAgentEvidenceSink {
  record(value: BrowserAgentEvidenceRecord): Promise<{ readonly evidenceArtifactId: string }>;
}

export interface BrowserAgentGateway {
  stream(request: CompleteRequest, signal: AbortSignal): AsyncIterable<GatewayStreamEvent>;
}

export interface BrowserAgentDependencies {
  readonly gateway: BrowserAgentGateway;
  readonly driver: BrowserAgentDriver;
  readonly evidence: BrowserAgentEvidenceSink;
  readonly redact: (value: string) => string;
  readonly countRequestTokens: (request: CompleteRequest) => number;
}

const BrowserAgentStepSchema = z
  .object({
    tool: z.enum(BROWSER_AGENT_TOOL_NAMES),
    input: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    source: z.enum(['dom', 'accessibility', 'network', 'console', 'screenshot']),
    evidenceArtifactId: idSchema('art'),
  })
  .strict();
export type BrowserAgentStep = z.infer<typeof BrowserAgentStepSchema>;

export const BrowserAgentFlowResultSchema = z
  .object({
    status: z.enum(['completed', 'budget_exhausted', 'failed']),
    steps: z.array(BrowserAgentStepSchema),
    finalResponse: z.string().optional(),
    errorCode: z.string().optional(),
  })
  .strict();
export type BrowserAgentFlowResult = z.infer<typeof BrowserAgentFlowResultSchema>;

const EMPTY_INPUT = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
};
const REF_PROPERTY = {
  type: 'string' as const,
  pattern: '^element_[1-9][0-9]*$',
};

const BROWSER_TOOLS: readonly NeutralTool[] = [
  {
    name: 'snapshotAccessibilityTree',
    description: 'Capture the current accessibility tree.',
    inputJsonSchema: EMPTY_INPUT,
  },
  {
    name: 'listInteractive',
    description: 'List visible interactive elements with opaque references.',
    inputJsonSchema: EMPTY_INPUT,
  },
  {
    name: 'click',
    description: 'Click a previously listed interactive element.',
    inputJsonSchema: {
      type: 'object',
      properties: { ref: REF_PROPERTY },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'fill',
    description: 'Fill a previously listed form control.',
    inputJsonSchema: {
      type: 'object',
      properties: {
        ref: REF_PROPERTY,
        value: { type: 'string', maxLength: 65_536 },
      },
      required: ['ref', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'expectVisibleText',
    description: 'Require visible page text and report the DOM match count.',
    inputJsonSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 2_048 } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'readConsole',
    description: 'Read captured browser console and page errors.',
    inputJsonSchema: EMPTY_INPUT,
  },
  {
    name: 'readFailedRequests',
    description: 'Read failed requests and HTTP responses with status 400 or greater.',
    inputJsonSchema: EMPTY_INPUT,
  },
  {
    name: 'screenshot',
    description: 'Capture a supplemental PNG screenshot artifact.',
    inputJsonSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
        },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
];

const EmptyInputSchema = z.object({}).strict();
const RefInputSchema = z.object({ ref: z.string().regex(/^element_[1-9][0-9]*$/u) }).strict();
const FillInputSchema = RefInputSchema.extend({ value: z.string().max(65_536) }).strict();
const TextInputSchema = z.object({ text: z.string().trim().min(1).max(2_048) }).strict();
const ScreenshotInputSchema = z
  .object({ label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u) })
  .strict();

const ABORTED = Symbol('aborted');

function isToolName(value: string): value is BrowserAgentToolName {
  return (BROWSER_AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

function closeIterator(iterator: AsyncIterator<GatewayStreamEvent>): void {
  if (iterator.return === undefined) return;
  void iterator.return().catch(() => undefined);
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (signal.aborted) return ABORTED;
  return await new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => {
      resolve(ABORTED);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Asynchronous operation failed'));
      },
    );
  });
}

function redactedJson(value: unknown, redact: (value: string) => string): JsonValue {
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => redactedJson(item, redact));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactedJson(item, redact)]),
    );
  }
  return null;
}

function durableInput(
  tool: BrowserAgentToolName,
  input: Record<string, JsonValue>,
  redact: (value: string) => string,
): Record<string, string | number | boolean | null> {
  if (tool === 'fill') {
    const ref = typeof input.ref === 'string' ? input.ref : '';
    return { ref: redact(ref), value: '[REDACTED]' };
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === 'string' ? redact(value) : typeof value === 'object' ? null : value,
    ]),
  );
}

function sourceForTool(tool: BrowserAgentToolName): BrowserPrimitiveSource {
  if (tool === 'snapshotAccessibilityTree') return 'accessibility';
  if (tool === 'readConsole') return 'console';
  if (tool === 'readFailedRequests') return 'network';
  if (tool === 'screenshot') return 'screenshot';
  return 'dom';
}

function transcriptInput(
  tool: BrowserAgentToolName,
  input: Record<string, JsonValue>,
  redact: (value: string) => string,
): Record<string, JsonValue> {
  const redacted = redactedJson(input, redact);
  if (typeof redacted !== 'object' || Array.isArray(redacted) || redacted === null) return {};
  if (tool === 'fill') return { ...redacted, value: '[REDACTED]' };
  return redacted;
}

async function invokeTool(
  driver: BrowserAgentDriver,
  tool: BrowserAgentToolName,
  input: Record<string, JsonValue>,
): Promise<BrowserPrimitiveObservation> {
  if (tool === 'snapshotAccessibilityTree') {
    EmptyInputSchema.parse(input);
    return await driver.snapshotAccessibilityTree();
  }
  if (tool === 'listInteractive') {
    EmptyInputSchema.parse(input);
    return await driver.listInteractive();
  }
  if (tool === 'click') {
    const parsed = RefInputSchema.parse(input);
    return await driver.click(parsed.ref);
  }
  if (tool === 'fill') {
    const parsed = FillInputSchema.parse(input);
    return await driver.fill(parsed.ref, parsed.value);
  }
  if (tool === 'expectVisibleText') {
    const parsed = TextInputSchema.parse(input);
    return await driver.expectVisibleText(parsed.text);
  }
  if (tool === 'readConsole') {
    EmptyInputSchema.parse(input);
    return await driver.readConsole();
  }
  if (tool === 'readFailedRequests') {
    EmptyInputSchema.parse(input);
    return await driver.readFailedRequests();
  }
  const parsed = ScreenshotInputSchema.parse(input);
  return await driver.screenshot(parsed.label);
}

function systemPrompt(): string {
  return [
    'You are the verifier browser agent. Explore only the supplied critical flow.',
    'Use only the provided browser tools. Treat DOM, accessibility, network, and console observations as assertion evidence.',
    'Screenshots are supplemental and never sufficient evidence by themselves.',
    'When finished, return only JSON with status and evidenceArtifactIds. Do not use markdown.',
  ].join(' ');
}

function userPrompt(flow: BrowserFlow): string {
  return JSON.stringify({ flow: flow.flow, journey: flow.journey });
}

export function browserAgentCompletionId(
  input: BrowserAgentSessionInput,
  flowIndex: number,
  turn: number,
): string {
  const parsed = BrowserAgentSessionInputSchema.parse(input);
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        organizationId: parsed.organizationId,
        projectId: parsed.projectId,
        runId: parsed.runId,
        taskId: parsed.taskId,
        flowIndex,
        turn,
      }),
    )
    .digest('hex');
  return `cmp_${digest}`;
}

function makeRequest(
  input: BrowserAgentFlowInput,
  messages: ChatMessage[],
  turn: number,
  dependencies: BrowserAgentDependencies,
): CompleteRequest {
  const sessionInput = BrowserAgentSessionInputSchema.parse({
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    taskId: input.taskId,
    flows: input.flows,
  });
  const base = CompleteRequestSchema.parse({
    completionId: browserAgentCompletionId(sessionInput, input.flowIndex, turn),
    organizationId: input.organizationId,
    projectId: input.projectId,
    runId: input.runId,
    taskId: input.taskId,
    agentRole: 'verifier',
    messages,
    tools: BROWSER_TOOLS,
    cacheBreakpointMessageIndexes: [0, 1],
    maxInputTokens: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  const maxInputTokens = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(dependencies.countRequestTokens(base));
  return CompleteRequestSchema.parse({ ...base, maxInputTokens });
}

function failed(steps: BrowserAgentStep[], errorCode: string): BrowserAgentFlowResult {
  return BrowserAgentFlowResultSchema.parse({ status: 'failed', steps, errorCode });
}

export async function runBrowserAgentFlow(
  unparsedInput: BrowserAgentFlowInput,
  dependencies: BrowserAgentDependencies,
): Promise<BrowserAgentFlowResult> {
  const input = BrowserAgentFlowInputSchema.parse(unparsedInput);
  if (input.flows[input.flowIndex]?.flow !== input.flow.flow) {
    return failed([], 'flow_scope_mismatch');
  }
  const controller = new AbortController();
  const budgetTimer = setTimeout(() => {
    controller.abort('flow_budget_exhausted');
  }, BROWSER_AGENT_FLOW_BUDGET_MS);
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt(input.flow) },
  ];
  const steps: BrowserAgentStep[] = [];

  try {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
      if (controller.signal.aborted) {
        return BrowserAgentFlowResultSchema.parse({
          status: 'budget_exhausted',
          steps,
          errorCode: 'flow_budget_exhausted',
        });
      }

      let request: CompleteRequest;
      try {
        request = makeRequest(input, messages, turn, dependencies);
      } catch {
        return failed(steps, 'request_invalid');
      }

      const text: string[] = [];
      const toolCalls: Array<{
        readonly toolCallId: string;
        readonly toolName: string;
        readonly input: Record<string, JsonValue>;
      }> = [];
      let terminal = false;
      let iterator: AsyncIterator<GatewayStreamEvent> | undefined;
      try {
        iterator = dependencies.gateway.stream(request, controller.signal)[Symbol.asyncIterator]();
        for (;;) {
          const next = await raceWithAbort(iterator.next(), controller.signal);
          if (next === ABORTED) {
            closeIterator(iterator);
            return BrowserAgentFlowResultSchema.parse({
              status: 'budget_exhausted',
              steps,
              errorCode: 'flow_budget_exhausted',
            });
          }
          if (next.done) break;
          const event = GatewayStreamEventSchema.parse(next.value);
          if (event.type === 'text-delta') text.push(dependencies.redact(event.text));
          if (event.type === 'tool-call') {
            toolCalls.push({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
            });
          }
          if (event.type === 'error') {
            closeIterator(iterator);
            return failed(steps, event.code);
          }
          if (event.type === 'done') terminal = true;
        }
      } catch {
        if (iterator !== undefined) closeIterator(iterator);
        return failed(steps, 'gateway_stream_invalid');
      }

      if (!terminal) return failed(steps, 'gateway_stream_incomplete');

      const responseText = text.join('');
      if (toolCalls.length === 0) {
        if (responseText.trim() === '') return failed(steps, 'empty_response');
        return BrowserAgentFlowResultSchema.parse({
          status: 'completed',
          steps,
          finalResponse: responseText,
        });
      }

      for (const call of toolCalls) {
        if (!isToolName(call.toolName)) return failed(steps, 'unknown_tool');
      }

      messages.push({
        role: 'assistant',
        content: [
          ...(responseText === '' ? [] : [{ type: 'text' as const, text: responseText }]),
          ...toolCalls.map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: isToolName(call.toolName)
              ? transcriptInput(call.toolName, call.input, dependencies.redact)
              : {},
          })),
        ],
      });

      for (const call of toolCalls) {
        const tool = call.toolName as BrowserAgentToolName;
        let observation: BrowserPrimitiveObservation;
        try {
          const pendingObservation = invokeTool(dependencies.driver, tool, call.input);
          const observed = await raceWithAbort(pendingObservation, controller.signal);
          if (observed === ABORTED) {
            return BrowserAgentFlowResultSchema.parse({
              status: 'budget_exhausted',
              steps,
              errorCode: 'flow_budget_exhausted',
            });
          }
          observation = BrowserPrimitiveObservationSchema.parse(observed);
          if (observation.source !== sourceForTool(tool)) {
            return failed(steps, 'tool_observation_source_mismatch');
          }
        } catch {
          return failed(steps, 'tool_execution_failed');
        }

        const modelValue = redactedJson(observation.modelValue, dependencies.redact);
        const body =
          observation.attachment?.body ?? new TextEncoder().encode(JSON.stringify(modelValue));
        let evidenceArtifactId: string;
        try {
          const recorded = await dependencies.evidence.record(
            EvidenceRecordInputSchema.parse({
              flow: input.flow.flow,
              stepIndex: steps.length,
              source: observation.source,
              label: dependencies.redact(observation.label),
              contentType: observation.attachment?.contentType ?? 'application/json',
              body,
            }),
          );
          evidenceArtifactId = idSchema('art').parse(recorded.evidenceArtifactId);
        } catch {
          return failed(steps, 'evidence_write_failed');
        }

        steps.push(
          BrowserAgentStepSchema.parse({
            tool,
            input: durableInput(tool, call.input, dependencies.redact),
            source: observation.source,
            evidenceArtifactId,
          }),
        );
        const resultForModel: JsonValue = {
          evidenceArtifactId,
          source: observation.source,
          label: dependencies.redact(observation.label),
          observation: modelValue,
        };
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: tool,
              output: { type: 'json', value: resultForModel },
            },
          ],
        });
      }
    }
    return failed(steps, 'turn_budget_exhausted');
  } finally {
    clearTimeout(budgetTimer);
  }
}
