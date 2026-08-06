export {};

const provider = '@ai-sdk/openai';
let assign;
({ assign } = Object);
const box = { load: console.log };

assign(box, { load: require });
assign = (_target, _source) => undefined;
box.load(provider);
