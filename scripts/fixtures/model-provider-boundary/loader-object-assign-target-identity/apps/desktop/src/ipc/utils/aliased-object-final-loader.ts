export {};

const provider = '@ai-sdk/openai';
const box = { load: console.warn };
const target = box;
let assign;
assign = Object.assign;
assign(target, { load: console.info }, { load: require });
box.load(provider);
