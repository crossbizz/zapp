export {};

const invokeCall = Function.prototype.call;
const { apply: invokeApply } = Function.prototype;

invokeCall.call(console.log, undefined, '@ai-sdk/openai');
invokeApply.apply(console.info, [undefined, ['@ai-sdk/anthropic']]);
