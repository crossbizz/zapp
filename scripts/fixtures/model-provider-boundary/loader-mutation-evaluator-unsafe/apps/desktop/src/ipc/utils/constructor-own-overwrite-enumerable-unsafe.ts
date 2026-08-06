export {};

const provider = '@ai-sdk/openai';

class Box {
  constructor() {
    this.load = require;
  }

  load(_value: string) {}
}

const copy = { ...new Box() };
copy.load(provider);
