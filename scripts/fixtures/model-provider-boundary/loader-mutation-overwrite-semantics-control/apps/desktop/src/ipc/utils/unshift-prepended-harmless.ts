export {};

const provider = '@ai-sdk/anthropic';
const box: Array<NodeRequire | typeof console.log> = [require];

box.unshift(console.log);
box[0](provider);
