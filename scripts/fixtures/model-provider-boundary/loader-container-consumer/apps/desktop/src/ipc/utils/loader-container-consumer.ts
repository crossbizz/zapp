function consume(loaders: { nested: NodeRequire[] }) {
  loaders.nested[0]('@ai-sdk/openai').createOpenAI({});
}

consume({ nested: [require] });
