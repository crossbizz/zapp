export {};

const invoke = Function.prototype.apply;

invoke.call(require, undefined, ['@ai-sdk/openai']).createOpenAI({});
