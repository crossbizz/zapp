export {};

declare function unknown(): object;

const provider = '@ai-sdk/openai';
const box = { load: console.info };

Object.assign(box, unknown(), { load: require });
box.load(provider);
