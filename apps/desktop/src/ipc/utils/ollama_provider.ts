import type { FetchFunction } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

export interface OllamaProviderOptions {
  baseURL?: string;
  headers?: Record<string, string>;
  fetch?: FetchFunction;
}

export interface OllamaChatSettings {}
export interface OllamaProvider {
  (modelId: string, settings?: OllamaChatSettings): LanguageModel;
}

export function createOllamaProvider(
  _options?: OllamaProviderOptions,
): OllamaProvider {
  return () => {
    throw new Error(
      "Direct local-model providers are disabled in zapp local sessions.",
    );
  };
}
