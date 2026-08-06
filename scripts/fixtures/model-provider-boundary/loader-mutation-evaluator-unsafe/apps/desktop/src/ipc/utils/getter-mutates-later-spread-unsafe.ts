export {};

const provider = '@ai-sdk/openai';
const source = {
  get 0() {
    this[1] = require;
    return 0;
  },
  1: console.log,
};
const copy = { ...source };
copy[1](provider);
