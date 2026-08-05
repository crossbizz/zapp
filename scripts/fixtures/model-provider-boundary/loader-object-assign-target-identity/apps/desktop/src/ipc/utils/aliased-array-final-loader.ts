export {};

const provider = '@ai-sdk/openai';
const box = [console.warn];
const target = box;
let assign;
assign = Object.assign;
assign(target, { 0: console.info }, { 0: require });
box[0](provider);
