export {};

Function.prototype.apply.call(Function.prototype.call, console.info, [
  undefined,
  '@ai-sdk/anthropic',
]);
