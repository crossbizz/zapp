export {};

const provider = '@ai-sdk/openai';

class Box {
  load = console.log;

  constructor(load = console.log) {
    this.load = load;
  }

  fire() {
    this.load(provider);
  }

  disarm() {
    this.load = console.info;
  }
}

const boxes = [console.log, require].map((load) => new Box(load));
boxes[0].fire();
