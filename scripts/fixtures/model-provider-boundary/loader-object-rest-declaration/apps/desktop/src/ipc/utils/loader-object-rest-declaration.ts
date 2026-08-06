const source = { keep: 'safe', nested: { load: require } };
const { keep: _keep, ...rest } = source;
const { nested: { load = console.log } = { load: console.log } } = rest;

load('@ai-sdk/openai').createOpenAI({});
