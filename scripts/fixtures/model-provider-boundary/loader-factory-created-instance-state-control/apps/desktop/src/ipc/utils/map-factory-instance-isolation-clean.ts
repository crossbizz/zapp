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

function makeBox(load) {
  return new Box(load);
}

const boxes = [console.log, require].map((load) => makeBox(load));
boxes[0].fire();
