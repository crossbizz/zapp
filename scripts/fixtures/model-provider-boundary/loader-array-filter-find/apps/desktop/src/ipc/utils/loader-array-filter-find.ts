const load = [console.log, require].filter(Boolean).find((value) => value === require);

load!('@ai-sdk/openai').createOpenAI({});
