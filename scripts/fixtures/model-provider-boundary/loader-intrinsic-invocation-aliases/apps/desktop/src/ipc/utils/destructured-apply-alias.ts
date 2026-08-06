export {};

const { apply: invoke } = Function.prototype;

invoke.apply(require, [undefined, ['@ai-sdk/openai']]).createOpenAI({});
