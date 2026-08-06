export {};

Function.prototype.call.apply(Function.prototype.apply, [
  console.log,
  undefined,
  ['@ai-sdk/openai'],
]);
