export {};

const provider = '@ai-sdk/openai';
const box = {};
const assign = Object.assign;

assign(box, { load: require });
box.load(provider);
