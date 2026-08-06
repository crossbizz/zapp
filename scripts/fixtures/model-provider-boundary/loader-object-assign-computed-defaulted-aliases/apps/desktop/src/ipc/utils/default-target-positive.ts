export {};

const provider = '@ai-sdk/openai';
let merge;
({ assign: merge = console.log } = Object);
const box = {};

merge(box, { load: require });
box.load(provider);
