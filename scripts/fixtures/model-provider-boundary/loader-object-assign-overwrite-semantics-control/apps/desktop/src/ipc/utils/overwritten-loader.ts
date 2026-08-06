export {};

const provider = '@ai-sdk/openai';
const box = { load: require };

Object.assign(box, { load: console.log });
box.load(provider);
