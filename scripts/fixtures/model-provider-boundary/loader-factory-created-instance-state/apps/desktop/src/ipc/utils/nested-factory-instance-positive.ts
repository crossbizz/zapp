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

function makeIndirectly() {
  return make();
}

const clean = makeIndirectly();
const armed = makeIndirectly();
armed.arm();
clean.disarm();
armed.fire();
