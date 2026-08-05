export {};

class LoaderBox {
  static load = require;
}

const Alias = LoaderBox;
Alias.load('@ai-sdk/openai').createOpenAI({});
