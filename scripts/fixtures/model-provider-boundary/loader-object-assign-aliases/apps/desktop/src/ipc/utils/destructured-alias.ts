export {};

const provider = '@ai-sdk/anthropic';
const box = {};
const { assign } = Object;

assign(box, { load: require });
box.load(provider);
