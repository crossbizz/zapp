function identity<T>(value: T): T {
  return value;
}

const loaders = identity({ nested: [require] });
identity(loaders).nested[0]('@ai-sdk/openai').createOpenAI({});
