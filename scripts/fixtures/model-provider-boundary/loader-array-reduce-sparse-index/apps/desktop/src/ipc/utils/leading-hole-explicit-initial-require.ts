export {};

const provider = '@ai-sdk/openai';
const slots = [, require];

slots.reduce((acc, _, index, owner) => {
  owner[index](provider);
  return acc;
}, console.log);
