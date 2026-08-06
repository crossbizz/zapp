[require].some((load) => {
  load('@ai-sdk/openai').createOpenAI({});
  return true;
});
