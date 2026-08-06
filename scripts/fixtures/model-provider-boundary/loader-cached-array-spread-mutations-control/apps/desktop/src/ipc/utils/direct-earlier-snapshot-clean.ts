export {};

const provider = '@ai-sdk/openai';
const queue = [console.info];
const before = { ...queue };

queue.push(require);

before[0](provider);
