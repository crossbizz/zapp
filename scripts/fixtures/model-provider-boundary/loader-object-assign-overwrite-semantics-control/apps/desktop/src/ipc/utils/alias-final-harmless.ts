export {};

const provider = '@ai-sdk/anthropic';
const box = { load: console.warn };
const assign = Object.assign;

assign(box, { load: require }, { load: console.info });
box.load(provider);
