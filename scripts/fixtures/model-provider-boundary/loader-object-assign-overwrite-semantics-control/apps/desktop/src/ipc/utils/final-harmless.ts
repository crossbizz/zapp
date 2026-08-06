export {};

const provider = '@ai-sdk/openai';
const box = { load: console.warn };

Object.assign(box, { load: require }, { load: console.log });
box.load(provider);
