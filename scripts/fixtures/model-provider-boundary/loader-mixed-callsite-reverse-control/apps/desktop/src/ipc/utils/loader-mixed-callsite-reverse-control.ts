function identity<T>(value: T): T {
  return value;
}

identity(console.log)('@ai-sdk/openai');
identity(require)('node:fs');
