export {};

const provider = '@ai-sdk/openai';

class Box {
  load = console.log;

  fire() {
    this.load(provider);
  }
}

function withLoader(load) {
  const box = new Box();
  box.load = load;
  return box;
}

const armed = withLoader(require);
const harmless = withLoader(console.info);
harmless.fire();
