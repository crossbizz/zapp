const source = { keep: 'safe', nested: { callback: console.log } };
const { keep: _keep, ...rest } = source;
const { nested: { callback = console.log } = { callback: console.log } } = rest;
let assigned = { nested: { callback: console.log } };
({ keep: {}, ...assigned } = { keep: {}, nested: { callback: console.log } });

callback('@ai-sdk/openai');
assigned.nested.callback('@ai-sdk/openai');
