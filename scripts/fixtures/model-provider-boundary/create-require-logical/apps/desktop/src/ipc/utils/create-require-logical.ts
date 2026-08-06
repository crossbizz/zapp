import { createRequire } from 'node:module';

const factory = undefined || createRequire;
factory(import.meta.url)('@ai-sdk/openai').createOpenAI({});
