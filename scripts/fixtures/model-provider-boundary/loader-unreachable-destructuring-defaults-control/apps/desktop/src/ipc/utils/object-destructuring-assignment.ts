export {};

const provider = '@ai-sdk/openai';
const source = { load: console.log };
let load: NodeRequire | typeof console.log = console.info;

({ load: load = require } = source);
load(provider);
