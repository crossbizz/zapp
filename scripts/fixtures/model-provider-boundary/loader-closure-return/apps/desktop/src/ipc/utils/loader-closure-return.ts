function makeLoader() {
  return () => require;
}

makeLoader()()('@ai-sdk/openai').createOpenAI({});
