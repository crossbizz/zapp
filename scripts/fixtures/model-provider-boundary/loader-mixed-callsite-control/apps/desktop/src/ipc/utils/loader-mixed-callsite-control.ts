function identity<T>(value: T): T {
  return value;
}

identity(require)('node:fs');
identity(console.log)('@ai-sdk/openai');
