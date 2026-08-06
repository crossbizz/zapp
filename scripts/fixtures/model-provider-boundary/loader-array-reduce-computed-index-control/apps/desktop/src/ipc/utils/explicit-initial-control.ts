const explicitProvider = '@ai-sdk/openai';
const explicitSlots = [console.log];

explicitSlots.reduce((acc, _, index, owner) => {
  owner[index](explicitProvider);
  return acc;
}, console.info);
