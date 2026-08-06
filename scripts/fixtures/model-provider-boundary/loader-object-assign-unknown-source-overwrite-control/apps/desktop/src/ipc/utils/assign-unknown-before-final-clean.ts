export {};

declare function unknown(): object;

const provider = '@ai-sdk/openai';
const box = { load: require };

Object.assign(box, unknown(), { load: console.info });
box.load(provider);
