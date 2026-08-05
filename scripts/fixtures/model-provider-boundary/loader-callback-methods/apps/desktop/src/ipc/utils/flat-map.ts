const load = [require].flatMap((candidate) => [candidate])[0];

load('@ai-sdk/openai').createOpenAI({});
