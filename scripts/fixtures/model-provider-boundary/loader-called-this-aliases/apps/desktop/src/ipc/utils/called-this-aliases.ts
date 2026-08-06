export {};

class LoaderBox {
  load: any;

  constructor() {
    this.load = require;
  }

  run(provider: string) {
    let self;
    let chained;
    self = this;
    chained = self;
    chained.load(provider);
  }
}

new LoaderBox().run('@ai-sdk/openai');
