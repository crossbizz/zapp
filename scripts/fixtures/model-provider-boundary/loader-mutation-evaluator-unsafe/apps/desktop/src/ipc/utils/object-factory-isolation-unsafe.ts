export {};

const provider = '@ai-sdk/openai';
function make() {
  return { load: console.log };
}
const armed = make();
const clean = make();
armed.load = require;
clean.load = console.info;
armed.load(provider);
