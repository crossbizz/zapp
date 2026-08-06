export {};

const provider = '@ai-sdk/openai';
let merge;
({ ['assign']: merge } = Object);
const box = {};

merge(box, { load: require });
box.load(provider);
