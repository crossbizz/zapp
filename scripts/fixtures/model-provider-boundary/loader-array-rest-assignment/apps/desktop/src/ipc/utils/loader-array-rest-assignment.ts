let rest = [[{ load: console.log }]];

[, ...rest] = [console.log, [{ load: require }]];
rest[0][0].load('@ai-sdk/openai').createOpenAI({});
