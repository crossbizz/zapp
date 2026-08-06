export {};

const provider = '@ai-sdk/openai';

class Box {
  load = console.log;

  arm() {
    this.load = require;
  }

  fire() {
    this.load(provider);
  }
}

function make(depth: number): Box {
  if (depth === 0) return new Box();
  return make(depth - 1);
}

const box = make(1);
box.arm();
box.fire();
