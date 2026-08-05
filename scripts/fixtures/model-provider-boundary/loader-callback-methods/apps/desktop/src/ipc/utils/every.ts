[require].every((load) => {
  load('@ai-sdk/openai').createOpenAI({});
  return true;
});
