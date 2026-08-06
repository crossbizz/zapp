import { createOpenAI } from '@ai-sdk/openai';

export const inheritedProvider = createOpenAI({});
const createSecondProvider = createOpenAI;
export const secondProvider = createSecondProvider({});
