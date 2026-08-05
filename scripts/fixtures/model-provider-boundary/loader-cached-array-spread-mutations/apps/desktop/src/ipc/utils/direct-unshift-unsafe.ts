export {};

const provider = '@ai-sdk/openai';
const queue = [console.info];
const before = { ...queue };

queue.unshift(require);

const after = { ...queue };
after[0](provider);
void before;
