const noInitialProvider = '@ai-sdk/openai';
const noInitialSlots = [console.log, require];

noInitialSlots.reduce((acc, _, index, owner) => {
  owner[index](noInitialProvider);
  return acc;
});
