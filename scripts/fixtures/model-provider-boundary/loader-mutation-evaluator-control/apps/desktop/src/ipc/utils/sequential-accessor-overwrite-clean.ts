export {};

const provider = '@ai-sdk/openai';
const box = {
  value: require,
  get value() {
    return console.log;
  },
};
box.value(provider);
