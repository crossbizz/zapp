export {};

const provider = '@ai-sdk/anthropic';
const box = [console.warn];
let assign;
assign = Object.assign;
assign(box, { 0: console.info }, { 0: require });
box[0](provider);
