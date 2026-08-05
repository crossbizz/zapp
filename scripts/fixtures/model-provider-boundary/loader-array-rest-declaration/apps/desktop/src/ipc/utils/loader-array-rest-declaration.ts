const [_head, ...rest] = [console.log, [{ load: require }]];
const [[{ load = console.log }]] = rest;

load('@ai-sdk/openai').createOpenAI({});
