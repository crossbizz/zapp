export {};

const provider = '@ai-sdk/anthropic';
const box = { load: console.log };
const assign = Object.assign;

assign(box, { load: console.info }, { load: require });
box.load(provider).createAnthropic({});
