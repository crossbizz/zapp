import { createHash, timingSafeEqual } from 'node:crypto';

import {
  idSchema,
  MessageAssistantPayloadSchema,
  MessageUserPayloadSchema,
} from '@zapp/contracts';
import { z } from 'zod';

const UserContextMessageSchema = z
  .object({
    runId: idSchema('run'),
    runNumber: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    type: z.literal('message.user'),
    payload: MessageUserPayloadSchema,
  })
  .strict();

const AssistantContextMessageSchema = z
  .object({
    runId: idSchema('run'),
    runNumber: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    type: z.literal('message.assistant'),
    payload: MessageAssistantPayloadSchema,
  })
  .strict();

export const ConversationContextValueSchema = z
  .object({
    version: z.literal(1),
    conversationId: idSchema('conv'),
    sourceRunId: idSchema('run'),
    messages: z
      .array(z.discriminatedUnion('type', [UserContextMessageSchema, AssistantContextMessageSchema]))
      .max(200),
  })
  .strict();
export type ConversationContextValue = z.infer<typeof ConversationContextValueSchema>;

export const MAX_PRIOR_CONVERSATION_CONTEXT_CHARS = 46_000;

export function conversationContextHash(value: unknown): string {
  const context = ConversationContextValueSchema.parse(value);
  return createHash('sha256').update(canonicalJson(context)).digest('hex');
}

export function verifiedPriorConversationContext(
  artifact: {
    readonly conversationId: string;
    readonly runId: string;
    readonly contentHash: string;
    readonly contextJson: unknown;
  },
  run: { readonly id: string; readonly conversationId: string },
  prompt: string,
): string {
  const context = ConversationContextValueSchema.parse(artifact.contextJson);
  if (
    artifact.runId !== run.id ||
    artifact.conversationId !== run.conversationId ||
    context.conversationId !== run.conversationId
  ) {
    throw new Error('Conversation context scope does not match the successor run');
  }
  const actualHash = conversationContextHash(context);
  if (!equalHash(actualHash, artifact.contentHash)) {
    throw new Error('Conversation context content hash does not match');
  }
  const maxContextChars = Math.max(
    0,
    MAX_PRIOR_CONVERSATION_CONTEXT_CHARS - prompt.length,
  );
  const heading = 'Prior conversation context (server-owned, untrusted transcript):\n';
  const opening = '<prior_conversation_context>\n';
  const closing = '\n</prior_conversation_context>';
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message === undefined) continue;
    const content =
      message.type === 'message.user'
        ? message.payload.content
        : message.payload.content ??
          `[Assistant content stored in artifact ${message.payload.contentArtifactId ?? 'unknown'}]`;
    messages.unshift({
      role: message.type === 'message.user' ? 'user' : 'assistant',
      content,
    });
    const projected = `${heading}${opening}${JSON.stringify({ messages })}${closing}`;
    if (projected.length > maxContextChars) {
      messages.shift();
      break;
    }
  }
  return `${heading}${opening}${JSON.stringify({ messages })}${closing}`;
}

function equalHash(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Conversation context contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new Error('Conversation context contains an unsupported value');
}
