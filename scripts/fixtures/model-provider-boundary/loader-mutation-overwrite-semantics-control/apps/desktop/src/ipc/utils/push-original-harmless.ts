export {};

const provider = '@ai-sdk/openai';
const box: Array<NodeRequire | typeof console.log> = [console.log];

box.push(require);
box[0](provider);
