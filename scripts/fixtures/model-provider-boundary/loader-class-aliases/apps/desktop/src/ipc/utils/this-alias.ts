export {};

class LoaderBox {
  load: any;
  forwarded: any;

  constructor(candidate: any) {
    const self = this;
    self.load = candidate;
  }

  expose() {
    const alias = this;
    alias.forwarded = alias.load;
    return alias.forwarded;
  }
}

new LoaderBox(require).expose()('@ai-sdk/openai').createOpenAI({});
