export {};

const provider = '@ai-sdk/openai';

class Box {
  load = console.log;

  constructor(load = console.log) {
    this.load = load;
  }

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

const boxes = [require, console.log].map((load) => new Box(load));
boxes[0].arm();
boxes[1].fire();
