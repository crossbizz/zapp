export {};

const provider = '@ai-sdk/openai';

class Box {
  load = console.log;

  arm() {
    const self = this;
    self.load = require;
  }

  fire() {
    const self = this;
    self.load(provider);
  }
}

const armed = new Box();
const harmless = new Box();
armed.arm();
harmless.fire();
