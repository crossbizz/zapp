function consume(getLoader: () => NodeRequire) {
  getLoader()('@ai-sdk/openai').createOpenAI({});
}

consume(() => require);
