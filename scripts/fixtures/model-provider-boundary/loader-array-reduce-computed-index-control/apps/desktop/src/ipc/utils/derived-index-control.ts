export {};

const provider = '@ai-sdk/openai';
const slots = [console.log, require, console.info];
const indexes = [2, 0];

slots.reduce((acc, _, index, owner) => {
  owner[indexes[index - 1]](provider);
  return acc;
});
