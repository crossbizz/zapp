function makeBox(field: NodeRequire) {
  class Box {
    inherited = field;

    constructor(readonly load: NodeRequire) {}

    getLoader() {
      return this.inherited;
    }
  }

  return new Box(field);
}

makeBox(require).getLoader()('@ai-sdk/openai').createOpenAI({});
