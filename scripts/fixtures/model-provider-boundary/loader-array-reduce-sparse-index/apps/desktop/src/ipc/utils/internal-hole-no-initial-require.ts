export {};

const provider = '@ai-sdk/openai';
const slots = [console.info, , console.log, require];

slots.reduce((acc, _, index, owner) => {
  owner[index](provider);
  return acc;
});
