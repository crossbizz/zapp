function identity<T>(value: T): T {
  return value;
}

if (process.env.USE_NODE_FS) {
  identity(require)('node:fs');
} else {
  identity(console.log)('@ai-sdk/openai');
}
