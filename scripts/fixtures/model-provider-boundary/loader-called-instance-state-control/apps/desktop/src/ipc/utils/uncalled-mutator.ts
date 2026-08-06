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

const box = new Box();
box.fire();
