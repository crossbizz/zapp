export {};

const provider = '@ai-sdk/openai';
const source = {};
let load: NodeRequire | typeof console.log = console.log;

({ load: load = require } = source);
load(provider).createOpenAI({});
