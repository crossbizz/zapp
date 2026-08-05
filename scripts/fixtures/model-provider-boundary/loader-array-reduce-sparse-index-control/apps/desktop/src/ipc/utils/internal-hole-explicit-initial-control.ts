export {};

const provider = '@ai-sdk/openai';
const slots = [console.log, , console.info];

slots.reduce((acc, _, index, owner) => {
  owner[index](provider);
  return acc;
}, console.warn);
