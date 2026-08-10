import type { FetchFunction } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import type { UserSettings } from "@/lib/schemas";

export type ExampleChatModelId = string & {};
export interface ChatParams {
  providerId: string;
}

export interface ExampleProviderSettings {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  fetch?: FetchFunction;
  dyadOptions: {
    enableLazyEdits?: boolean;
    enableSmartFilesContext?: boolean;
    enableWebSearch?: boolean;
  };
  settings: UserSettings;
}

export interface DyadEngineProvider {
  (modelId: ExampleChatModelId, chatParams: ChatParams): LanguageModel;
  chatModel(modelId: ExampleChatModelId, chatParams: ChatParams): LanguageModel;
  freeChatModel(modelId: ExampleChatModelId, chatParams: ChatParams): LanguageModel;
  responses(modelId: ExampleChatModelId, chatParams: ChatParams): LanguageModel;
  anthropic(modelId: ExampleChatModelId, chatParams: ChatParams): LanguageModel;
}

function unavailable(): never {
  throw new DyadError(
    "The inherited desktop provider engine is disabled; use the zapp model gateway.",
    DyadErrorKind.Precondition,
  );
}

export function createDyadEngine(_options: ExampleProviderSettings): DyadEngineProvider {
  return Object.assign(
    () => unavailable(),
    {
      chatModel: () => unavailable(),
      freeChatModel: () => unavailable(),
      responses: () => unavailable(),
      anthropic: () => unavailable(),
    },
  ) as DyadEngineProvider;
}

export async function transcribeWithDyadEngine(
  _audio: Uint8Array,
  _filename: string,
  _requestId: string,
  _options: ExampleProviderSettings,
): Promise<string> {
  return unavailable();
}
