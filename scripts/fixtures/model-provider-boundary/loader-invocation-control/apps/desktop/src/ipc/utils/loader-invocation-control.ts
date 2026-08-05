class Box {
  field = console.log;

  constructor(readonly callback: typeof console.log) {}

  getCallback() {
    return this.callback;
  }
}

console.log.call(undefined, '@ai-sdk/openai');
console.log.apply(undefined, ['@ai-sdk/openai']);
new Box(console.log).getCallback()('@ai-sdk/openai');
