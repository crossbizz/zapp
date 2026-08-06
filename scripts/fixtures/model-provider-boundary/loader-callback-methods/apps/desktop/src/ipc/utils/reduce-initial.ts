[console.log].reduce((load) => {
  load('@ai-sdk/openai').createOpenAI({});
  return load;
}, require);
