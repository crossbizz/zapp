export {};

const provider = '@ai-sdk/openai';
const box = { load: console.warn };
var target = box;
var target = { load: console.info };
Object.assign(target, { load: require });
box.load(provider);
