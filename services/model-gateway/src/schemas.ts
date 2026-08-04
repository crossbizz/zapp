import { z } from 'zod';

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
      }),
  ]),
);

export const InputJsonSchema = z
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

export const CompleteRequestSchema = z
  .object({
    organizationId: z.string(),
    projectId: z.string(),
    runId: z.string(),
    taskId: z.string().optional(),
    agentRole: z.enum(['planner', 'builder', 'verifier', 'summarizer']),
    messages: z.array(ChatMessageSchema),
    tools: z.array(NeutralToolSchema).optional(),
    maxOutputTokens: z.number().int().positive(),
    budget: z.object({ remainingCredits: z.number() }).strict().optional(),
  })
  .strict();

export type CompleteRequest = z.infer<typeof CompleteRequestSchema>;
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
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
const DoneStreamEventSchema = z.object({ type: z.literal('done') }).strict();
const ProviderErrorStreamEventSchema = z
  .object({
    type: z.literal('error'),
    code: z.literal('provider_error'),
    message: z.string(),
  })
  .strict();

export const BackendStreamEventSchema = z.discriminatedUnion('type', [
  TextDeltaStreamEventSchema,
  ToolCallStreamEventSchema,
  UsageStreamEventSchema,
]);

export const GatewayStreamEventSchema = z.discriminatedUnion('type', [
  TextDeltaStreamEventSchema,
  ToolCallStreamEventSchema,
  UsageStreamEventSchema,
  DoneStreamEventSchema,
  ProviderErrorStreamEventSchema,
]);

export type BackendStreamEvent = z.infer<typeof BackendStreamEventSchema>;
export type GatewayStreamEvent = z.infer<typeof GatewayStreamEventSchema>;
