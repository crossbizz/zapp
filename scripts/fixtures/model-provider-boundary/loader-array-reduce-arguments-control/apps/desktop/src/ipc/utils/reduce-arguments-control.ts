const callbacks = [console.log, console.info];

callbacks.reduce((accumulator, _element, index, array) => {
  array[index]('@ai-sdk/openai');
  return accumulator;
});
