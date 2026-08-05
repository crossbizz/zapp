export {};

const invoke = Function.prototype.call;

invoke.call(require, undefined, '@ai-sdk/openai').createOpenAI({});
