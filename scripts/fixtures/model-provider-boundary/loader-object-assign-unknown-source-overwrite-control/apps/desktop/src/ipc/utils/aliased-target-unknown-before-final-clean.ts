export {};

declare function unknown(): object;

const provider = '@ai-sdk/anthropic';
const box = { load: require };
const target = box;

Object.assign(target, unknown(), { load: console.info });
box.load(provider);
