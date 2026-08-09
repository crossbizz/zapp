import {
  jsonSchema,
  tool,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  type ToolResultPart,
} from 'ai';

import {
  JsonValueSchema,
  type BackendStreamEvent,
  type ChatMessage,
  type JsonValue,
} from '../schemas.js';
import type {
  AiSdkDependencies,
  AiSdkTool,
  ModelTerminalErrorCode,
  ProviderAdapter,
  ProviderInput,
} from './types.js';
import { ModelTerminalError } from './types.js';
import type { ProviderId } from '../models.js';

function convertTools(input: ProviderInput): Record<string, AiSdkTool> | undefined {
  if (input.request.tools === undefined) return undefined;

  return Object.fromEntries(
    input.request.tools.map((neutralTool) => [
      neutralTool.name,
      tool({
        description: neutralTool.description,
        inputSchema: jsonSchema(neutralTool.inputJsonSchema),
      }) as AiSdkTool,
    ]),
  );
}

function usageEvent(
  usage: LanguageModelUsage,
  provider: ProviderId,
  input: ProviderInput,
  finishReason: string,
): BackendStreamEvent {
  const cachedInputTokens = usage.inputTokenDetails.cacheReadTokens;
  const cacheWriteInputTokens = usage.inputTokenDetails.cacheWriteTokens;
  return {
    type: 'usage',
    provider,
    model: input.modelId,
    finishReason,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteInputTokens === undefined || cacheWriteInputTokens === 0
      ? {}
      : { cacheWriteInputTokens }),
  };
}

function terminalError(finishReason: string): ModelTerminalError | undefined {
  const outcomes: Readonly<Partial<Record<string, ModelTerminalErrorCode>>> = {
    length: 'output_limit_exceeded',
    'content-filter': 'content_filter',
    error: 'provider_error',
    other: 'unknown_finish_reason',
  };
  if (finishReason === 'stop' || finishReason === 'tool-calls') return undefined;
  const code = outcomes[finishReason] ?? 'unknown_finish_reason';
  const messages: Readonly<Record<ModelTerminalErrorCode, string>> = {
    provider_error: 'The model provider request failed.',
    content_filter: 'The model provider blocked the response.',
    output_limit_exceeded: 'The model reached its output token limit.',
    unknown_finish_reason: 'The model ended with an unsupported finish reason.',
  };
  return new ModelTerminalError(code, messages[code]);
}

function toolOutput(
  output: Extract<ChatMessage, { role: 'tool' }>['content'][number]['output'],
): ToolResultPart['output'] {
  if (output.type !== 'execution-denied') return output;
  return {
    type: 'execution-denied',
    ...(output.reason === undefined ? {} : { reason: output.reason }),
  };
}

const ANTHROPIC_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const;

function toModelPrompt(
  messages: ChatMessage[],
  cacheBreakpointMessageIndexes: readonly number[],
  provider: ProviderId,
): { readonly instructions?: SystemModelMessage[]; readonly messages: ModelMessage[] } {
  const instructions: SystemModelMessage[] = [];
  const modelMessages: ModelMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const cache = provider === 'anthropic' && cacheBreakpointMessageIndexes.includes(index);
    if (message.role === 'system') {
      instructions.push({
        ...message,
        ...(cache ? { providerOptions: ANTHROPIC_CACHE_CONTROL } : {}),
      });
      continue;
    }
    if (cache) {
      if (message.role === 'user' && typeof message.content === 'string') {
        modelMessages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: message.content,
              providerOptions: ANTHROPIC_CACHE_CONTROL,
            },
          ],
        });
        continue;
      }
      throw new Error('A prompt-cache breakpoint must name a cacheable system or user message.');
    }
    modelMessages.push(
      message.role !== 'tool'
        ? message
        : {
            role: 'tool',
            content: message.content.map((part) => ({
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: toolOutput(part.output),
            })),
          },
    );
  }
  return {
    ...(instructions.length === 0 ? {} : { instructions }),
    messages: modelMessages,
  };
}

function toolInput(input: unknown): Record<string, JsonValue> {
  const parsed = JsonValueSchema.parse(input);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('provider returned a non-object tool input');
  }
  return parsed;
}

export function createAiSdkAdapter(options: {
  readonly provider: ProviderId;
  readonly providerSettings: Parameters<AiSdkDependencies['createProvider']>[0];
  readonly dependencies: AiSdkDependencies;
}): ProviderAdapter {
  const provider = options.dependencies.createProvider(options.providerSettings);

  return {
    provider: options.provider,
    stream: (input) => {
      const tools = convertTools(input);
      const prompt = toModelPrompt(
        input.request.messages,
        input.request.cacheBreakpointMessageIndexes,
        options.provider,
      );
      const result = options.dependencies.streamText({
        model: provider(input.modelId),
        ...prompt,
        ...(tools === undefined ? {} : { tools }),
        maxOutputTokens: input.request.maxOutputTokens,
        abortSignal: input.signal,
      });

      return (async function* () {
        for await (const part of result.stream) {
          switch (part.type) {
            case 'text-delta':
              yield { type: 'text-delta', text: part.text };
              break;
            case 'tool-call':
              yield {
                type: 'tool-call',
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: toolInput(part.input),
              };
              break;
            case 'finish':
              yield usageEvent(part.totalUsage, options.provider, input, part.finishReason);
              {
                const error = terminalError(part.finishReason);
                if (error !== undefined) throw error;
              }
              break;
            case 'error':
              throw part.error;
            case 'abort':
              if (!input.signal.aborted) throw new Error('provider stream aborted');
              return;
            default:
              break;
          }
        }
      })();
    },
  };
}
