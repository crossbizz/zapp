export {};

const provider = '@ai-sdk/anthropic';
const source = [console.log];
let load: NodeRequire | typeof console.log = console.info;

[load = require] = source;
load(provider);
