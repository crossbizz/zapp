export {};

declare function unknown(): object;

const provider = '@ai-sdk/anthropic';
const box = { load: console.info };

Object.assign(box, { load: require }, unknown());
box.load(provider);
