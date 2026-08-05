import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export interface FixtureInterface extends OpenAICompatibleChatLanguageModel {}
export class FixtureImplementation implements OpenAICompatibleChatLanguageModel {}
export type FixtureLanguageModel = LanguageModel;
