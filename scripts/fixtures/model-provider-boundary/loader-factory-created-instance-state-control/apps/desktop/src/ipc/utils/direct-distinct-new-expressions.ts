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

const clean = new Box();
const armed = new Box();
clean.disarm();
armed.arm();
clean.fire();
