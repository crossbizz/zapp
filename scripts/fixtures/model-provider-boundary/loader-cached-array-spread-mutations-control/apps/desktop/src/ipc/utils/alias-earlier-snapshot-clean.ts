export {};

const provider = '@ai-sdk/openai';
const queue = [console.info];
const alias = queue;
const before = { ...queue };

alias.unshift(require);

before[0](provider);
