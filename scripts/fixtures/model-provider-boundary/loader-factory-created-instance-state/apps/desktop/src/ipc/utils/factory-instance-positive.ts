export {};

const provider = '@ai-sdk/openai';

class Box {
  load = console.log;

  arm() {
    this.load = require;
  }

  disarm() {
    this.load = console.info;
  }

  fire() {
    this.load(provider);
  }
}

function make() {
  return new Box();
}

const clean = make();
const armed = make();
armed.arm();
clean.disarm();
armed.fire();
