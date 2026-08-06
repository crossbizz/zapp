export {};

const Function = {
  prototype: {
    call: console.log,
    apply: console.info,
  },
};
const invokeCall = Function.prototype.call;
const { apply: invokeApply } = Function.prototype;

invokeCall.call(require, undefined, '@ai-sdk/openai');
invokeApply.apply(require, [undefined, ['@ai-sdk/anthropic']]);
