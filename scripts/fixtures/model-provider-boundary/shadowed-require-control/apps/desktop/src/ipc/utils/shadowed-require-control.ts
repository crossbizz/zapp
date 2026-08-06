function require(target: string) {
  return { createOpenAI: () => target };
}

function identity<T>(value: T): T {
  return value;
}

const pass = identity;
const loaders = { node: pass(require) };
loaders.node('@ai-sdk/openai').createOpenAI();
