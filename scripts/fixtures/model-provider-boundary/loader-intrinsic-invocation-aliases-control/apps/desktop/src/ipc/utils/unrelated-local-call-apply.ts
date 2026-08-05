export {};

const local = {
  call(_candidate: unknown, target: string) {
    console.log(target);
  },
  apply(_candidate: unknown, targets: string[]) {
    console.info(targets);
  },
};
const invokeCall = local.call;
const { apply: invokeApply } = local;

invokeCall.call(require, undefined, '@ai-sdk/openai');
invokeApply.apply(require, [undefined, ['@ai-sdk/anthropic']]);
