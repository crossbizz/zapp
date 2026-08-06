export {};

const provider = '@ai-sdk/openai';
const { assign: merge = Object.assign } = { assign: undefined };
const box = {};

merge(box, { load: require });
box.load(provider);
