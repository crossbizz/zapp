export {};

const provider = '@ai-sdk/openai';
const slots = [, require, console.log];

slots.reduce((acc, _, index, owner) => {
  owner[index](provider);
  return acc;
});
