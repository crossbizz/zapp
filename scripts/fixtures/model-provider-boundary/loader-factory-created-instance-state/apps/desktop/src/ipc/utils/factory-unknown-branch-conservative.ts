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

function configured(armed) {
  const box = new Box();
  if (armed) box.arm();
  else box.disarm();
  return box;
}

declare const unknown: boolean;
configured(unknown).fire();
