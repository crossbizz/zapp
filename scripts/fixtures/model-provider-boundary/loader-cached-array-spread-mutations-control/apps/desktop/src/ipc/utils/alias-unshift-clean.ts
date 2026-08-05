export {};

const provider = '@ai-sdk/openai';
const queue = [console.info];
const alias = queue;
const before = { ...queue };

alias.unshift(require);

const after = { ...queue };
after[1](provider);
void before;
