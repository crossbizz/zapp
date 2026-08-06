import type { LanguageModel, ModelMessage, Schema, TextStreamPart, ToolSet } from 'ai';

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

export interface AiSdkTool {
  readonly description: string;
  readonly inputSchema: Schema;
}

export interface AiSdkStreamOptions {
  readonly model: LanguageModel;
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
