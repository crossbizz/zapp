import type {
  LanguageModel,
  ModelMessage,
  Schema,
  SystemModelMessage,
  TextStreamPart,
  ToolSet,
} from 'ai';

import type { BackendStreamEvent, CompleteRequest } from '../schemas.js';
import type { ProviderId } from '../models.js';

export interface ProviderInput {
  readonly modelId: string;
  readonly request: CompleteRequest;
  readonly signal: AbortSignal;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly stream: (input: ProviderInput) => AsyncIterable<BackendStreamEvent>;
}

export type ModelTerminalErrorCode =
  | 'provider_error'
  | 'content_filter'
  | 'output_limit_exceeded'
  | 'unknown_finish_reason';

export class ModelTerminalError extends Error {
  constructor(
    readonly code: ModelTerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelTerminalError';
  }
}

export class ProviderAttemptError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    cause: unknown,
  ) {
    super('The model provider request failed.', { cause });
    this.name = 'ProviderAttemptError';
  }
}

export interface AiSdkTool {
  readonly description: string;
  readonly inputSchema: Schema;
}

export interface AiSdkStreamOptions {
  readonly model: LanguageModel;
  readonly instructions?: SystemModelMessage | SystemModelMessage[];
  readonly messages: ModelMessage[];
  readonly tools?: Record<string, AiSdkTool>;
  readonly maxOutputTokens: number;
  readonly abortSignal: AbortSignal;
}

export interface AiSdkProviderSettings {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly name?: string;
  readonly includeUsage?: boolean;
}

export interface AiSdkDependencies {
  createProvider(settings: AiSdkProviderSettings): (modelId: string) => LanguageModel;
  streamText(options: AiSdkStreamOptions): { readonly stream: AsyncIterable<TextStreamPart<ToolSet>> };
}
