export {};

const provider = '@ai-sdk/openai';
const box = { load: console.warn };
const target = box;
let assign;
assign = Object.assign;
assign(target, { load: require }, { load: console.info });
box.load(provider);
