export {};

const provider = '@ai-sdk/openai';
class Box {
  constructor(public load = require) {}
}
new Box().load(provider);
