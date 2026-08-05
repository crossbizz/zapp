const callbacks = [console.log, require];

callbacks.reduce((accumulator, _element, index, array) => {
  array[index]('@ai-sdk/openai').createOpenAI({});
  return accumulator;
});
