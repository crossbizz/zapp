export {};

const provider = '@ai-sdk/openai';
const source = {
  get 0() {
    this[1] = console.info;
    return 0;
  },
  1: require,
};
const { ...copy } = source;
copy[1](provider);
