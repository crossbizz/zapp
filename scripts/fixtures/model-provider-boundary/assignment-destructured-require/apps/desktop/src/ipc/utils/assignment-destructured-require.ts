let load: NodeRequire;

({ require: load } = module);
load('@ai-sdk/openai').createOpenAI({});
