export {};

const provider = '@ai-sdk/openai';
function make() {
  return { load: console.log };
}
const clean = make();
const armed = make();
clean.load = console.info;
armed.load = require;
clean.load(provider);
