class StaticOnly {
  static load = require;
  load = console.log;
}

class CallbackBox {
  callback: any;

  constructor(candidate: any) {
    const self = this;
    self.callback = candidate;
  }

  expose() {
    const alias = this;
    return alias.callback;
  }
}

new StaticOnly().load('@ai-sdk/openai');
new CallbackBox(console.info).expose()('@ai-sdk/openai');
