export {};

const { call: invoke } = Function.prototype;

invoke.apply(require, [undefined, '@ai-sdk/openai']).createOpenAI({});
