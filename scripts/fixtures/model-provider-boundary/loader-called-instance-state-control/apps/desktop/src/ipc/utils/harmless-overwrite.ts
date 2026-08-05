export {};

const provider = '@ai-sdk/openai';

class Box {
  load = require;

  disarm() {
    const self = this;
    self.load = console.log;
  }

  fire() {
    const self = this;
    self.load(provider);
  }
}

const box = new Box();
box.disarm();
box.fire();
