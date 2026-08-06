export {};

const provider = '@ai-sdk/anthropic';
const source: Array<typeof console.log> = [];
let load: NodeRequire | typeof console.log = console.log;

[load = require] = source;
load(provider).createAnthropic({});
