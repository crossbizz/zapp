import { z } from 'zod';
import {
  CompletionIdSchema,
  CompletionUsageSchema,
  CreditStateSchema,
  GatewayStreamEventSchema as PublicGatewayStreamEventSchema,
  type GatewayStreamEvent as PublicGatewayStreamEvent,
} from '@zapp/contracts';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);

const JsonObjectValueSchema = z.record(JsonValueSchema);

const StringJsonSchema = z
  .object({
    type: z.literal('string'),
    description: z.string().optional(),
    enum: z.array(z.string()).nonempty().optional(),
    const: z.string().optional(),
    default: z.string().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    pattern: z.string().optional(),
    format: z.string().optional(),
  })
  .strict();

const NumberJsonSchema = z
  .object({
    type: z.enum(['number', 'integer']),
    description: z.string().optional(),
    enum: z.array(z.number()).nonempty().optional(),
    const: z.number().optional(),
    default: z.number().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    exclusiveMinimum: z.number().optional(),
    exclusiveMaximum: z.number().optional(),
    multipleOf: z.number().positive().optional(),
  })
  .strict();

const BooleanJsonSchema = z
  .object({
    type: z.literal('boolean'),
    description: z.string().optional(),
    enum: z.array(z.boolean()).nonempty().optional(),
    const: z.boolean().optional(),
    default: z.boolean().optional(),
  })
  .strict();

const NullJsonSchema = z
  .object({
    type: z.literal('null'),
    description: z.string().optional(),
  })
  .strict();

const JsonSchemaNode: z.ZodTypeAny = z.lazy(() =>
  z.union([
    StringJsonSchema,
    NumberJsonSchema,
    BooleanJsonSchema,
    NullJsonSchema,
    z
      .object({
        type: z.literal('array'),
        description: z.string().optional(),
        items: JsonSchemaNode,
        minItems: z.number().int().nonnegative().optional(),
        maxItems: z.number().int().nonnegative().optional(),
        uniqueItems: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('object'),
        description: z.string().optional(),
        properties: z.record(JsonSchemaNode),
        required: z.array(z.string()).optional(),
        additionalProperties: z.union([z.boolean(), JsonSchemaNode]).optional(),
        minProperties: z.number().int().nonnegative().optional(),
        maxProperties: z.number().int().nonnegative().optional(),
      })
      .strict()
      .superRefine((schema, context) => {
        const propertyNames = new Set(Object.keys(schema.properties));
        const required = schema.required ?? [];
        if (new Set(required).size !== required.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'required keys must be unique',
          });
        }
        for (const name of required) {
          if (!propertyNames.has(name)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'required keys must name a property',
              path: ['required'],
            });
          }
        }
      }),
    z
      .object({
        description: z.string().optional(),
        anyOf: z.array(JsonSchemaNode).min(1),
      })
      .strict(),
  ]),
);

const ObjectInputJsonSchema = z
  .object({
    type: z.literal('object'),
    description: z.string().optional(),
    properties: z.record(JsonSchemaNode),
    required: z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), JsonSchemaNode]).optional(),
    minProperties: z.number().int().nonnegative().optional(),
    maxProperties: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((schema, context) => {
    const propertyNames = new Set(Object.keys(schema.properties));
    const required = schema.required ?? [];
    if (new Set(required).size !== required.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'required keys must be unique' });
    }
    for (const name of required) {
      if (!propertyNames.has(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'required keys must name a property',
          path: ['required'],
        });
      }
    }
  });

function isObjectInputAlternative(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object') return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.every(isObjectInputAlternative);
}

const ObjectUnionInputJsonSchema = z
  .object({
    description: z.string().optional(),
    anyOf: z.array(JsonSchemaNode).min(1),
  })
  .strict()
  .superRefine((schema, context) => {
    if (!schema.anyOf.every(isObjectInputAlternative)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tool input alternatives must all describe objects',
        path: ['anyOf'],
      });
    }
  });

export const InputJsonSchema = z.union([
  ObjectInputJsonSchema,
  ObjectUnionInputJsonSchema,
]);

const TextPartSchema = z.object({ type: z.literal('text'), text: z.string() }).strict();
const ToolCallPartSchema = z
  .object({
    type: z.literal('tool-call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: JsonObjectValueSchema,
  })
  .strict();
const ToolResultOutputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }).strict(),
  z.object({ type: z.literal('json'), value: JsonValueSchema }).strict(),
  z.object({ type: z.literal('error-text'), value: z.string() }).strict(),
  z.object({ type: z.literal('error-json'), value: JsonValueSchema }).strict(),
  z.object({ type: z.literal('execution-denied'), reason: z.string().optional() }).strict(),
]);
const ToolResultPartSchema = z
  .object({
    type: z.literal('tool-result'),
    toolCallId: z.string(),
    toolName: z.string(),
    output: ToolResultOutputSchema,
  })
  .strict();

export const ChatMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }).strict(),
  z
    .object({
      role: z.literal('user'),
      content: z.union([z.string(), z.array(TextPartSchema)]),
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.union([z.string(), z.array(z.union([TextPartSchema, ToolCallPartSchema]))]),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      content: z.array(ToolResultPartSchema),
    })
    .strict(),
]);

export const NeutralToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    inputJsonSchema: InputJsonSchema,
  })
  .strict();

export const AccountingReplaySchema = z
  .object({
    version: z.literal(1),
    requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const CompleteRequestObjectSchema = z
  .object({
    completionId: z.string().regex(/^cmp_[a-f0-9]{64}$/u),
    organizationId: z.string(),
    projectId: z.string(),
    runId: z.string(),
    taskId: z.string().optional(),
    agentRole: z.enum(['planner', 'builder', 'verifier', 'summarizer']),
    messages: z.array(ChatMessageSchema),
    tools: z.array(NeutralToolSchema).optional(),
    cacheBreakpointMessageIndexes: z.array(z.number().int().nonnegative()).max(4).default([]),
    maxInputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().positive(),
    budget: z.object({ remainingCredits: z.number() }).strict().optional(),
    accountingReplay: AccountingReplaySchema.optional(),
  })
  .strict();

function validateCacheBreakpoints(
  request: { readonly cacheBreakpointMessageIndexes: number[]; readonly messages: unknown[] },
  context: z.RefinementCtx,
): void {
  if (
    new Set(request.cacheBreakpointMessageIndexes).size !==
    request.cacheBreakpointMessageIndexes.length
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cache breakpoint message indexes must be unique',
      path: ['cacheBreakpointMessageIndexes'],
    });
  }
  for (const index of request.cacheBreakpointMessageIndexes) {
    if (index >= request.messages.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cache breakpoint message index is outside the message list',
        path: ['cacheBreakpointMessageIndexes'],
      });
    }
  }
}

export const CompleteRequestSchema =
  CompleteRequestObjectSchema.superRefine(validateCacheBreakpoints);

/** Public desktop payload; the control plane supplies and verifies every accounting identity. */
export const LocalAgentCompletionRequestSchema = CompleteRequestObjectSchema.omit({
  organizationId: true,
  projectId: true,
  runId: true,
  taskId: true,
  accountingReplay: true,
}).superRefine(validateCacheBreakpoints);

export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;
export type AccountingReplay = z.infer<typeof AccountingReplaySchema>;
export type LocalAgentCompletionRequest = z.infer<typeof LocalAgentCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type NeutralTool = z.infer<typeof NeutralToolSchema>;

const TextDeltaStreamEventSchema = z
  .object({ type: z.literal('text-delta'), text: z.string() })
  .strict();
const ToolCallStreamEventSchema = z
  .object({
    type: z.literal('tool-call'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: JsonObjectValueSchema,
  })
  .strict();
const UsageStreamEventSchema = z
  .object({
    type: z.literal('usage'),
    provider: z.string().min(1),
    model: z.string().min(1),
    finishReason: z.string().min(1),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
const UsageRecordedStreamEventSchema = z
  .object({
    type: z.literal('usage.recorded'),
    completionId: CompletionIdSchema,
    usage: z.array(CompletionUsageSchema).min(1).max(16),
    credits: CreditStateSchema,
  })
  .strict();
export const BackendStreamEventSchema = z.discriminatedUnion('type', [
  TextDeltaStreamEventSchema,
  ToolCallStreamEventSchema,
  UsageStreamEventSchema,
  UsageRecordedStreamEventSchema,
]);

export const GatewayStreamEventSchema = PublicGatewayStreamEventSchema;

export type BackendStreamEvent = z.infer<typeof BackendStreamEventSchema>;
export type GatewayStreamEvent = PublicGatewayStreamEvent;
