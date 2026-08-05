export {};

const provider = '@ai-sdk/openai';
const safe = { load: require };
const alias = safe;
alias.load = console.info;
const source = { load: require, ...safe };

source.load(provider);
