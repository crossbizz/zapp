function identity<T>(value: T): T {
  return value;
}

const pass = identity;
const load = pass(require);
load('@ai-sdk/openai').createOpenAI({});
