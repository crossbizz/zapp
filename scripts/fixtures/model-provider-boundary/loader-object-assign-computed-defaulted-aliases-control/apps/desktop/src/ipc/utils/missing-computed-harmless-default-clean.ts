export {};

const provider = '@ai-sdk/openai';
const key = 'other';
const { [key]: merge = () => undefined } = {};
const box = { load: console.log };

merge(box, { load: require });
box.load(provider);
