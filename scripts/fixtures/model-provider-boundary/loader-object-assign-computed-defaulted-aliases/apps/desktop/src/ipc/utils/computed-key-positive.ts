export {};

const provider = '@ai-sdk/openai';
const key = 'assign';
let merge;
({ [key]: merge } = Object);
const box = {};

merge(box, { load: require });
box.load(provider);
