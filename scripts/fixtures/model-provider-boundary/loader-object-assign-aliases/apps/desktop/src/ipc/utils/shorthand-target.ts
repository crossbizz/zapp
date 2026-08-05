export {};

const provider = '@ai-sdk/openai';
let assign;
({ assign } = Object);
const merge = assign;
const box = { load: console.log };

merge(box, { load: require });
box.load(provider);
