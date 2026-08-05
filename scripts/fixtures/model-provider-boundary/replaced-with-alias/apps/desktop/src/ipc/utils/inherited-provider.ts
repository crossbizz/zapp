import { createOpenAI } from '@ai-sdk/openai';

const createProvider = createOpenAI;
export const firstProvider = createProvider({});
export const secondProvider = createProvider({});
