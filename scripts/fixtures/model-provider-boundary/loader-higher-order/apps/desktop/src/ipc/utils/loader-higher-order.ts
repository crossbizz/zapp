function loadWith(loader: NodeRequire, target: string) {
  return loader(target);
}

loadWith(require, '@ai-sdk/openai').createOpenAI({});
