import { createOpenAI } from '@ai-sdk/openai';

let createProvider: typeof createOpenAI;
createProvider = createOpenAI;
export const firstProvider = createProvider({});
export const secondProvider = createProvider({});
