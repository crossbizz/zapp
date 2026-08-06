export {};

const provider = '@ai-sdk/openai';
const key = 'missing';
let merge;
({ [key]: merge = console.log } = Object);
const box = { load: console.info };

merge(box, { load: require });
box.load(provider);
