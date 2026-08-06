const load = [console.log, require].reduce((_accumulator, value) => value);

load('@ai-sdk/openai').createOpenAI({});
