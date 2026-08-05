export {};

const provider = '@ai-sdk/anthropic';
let merge;
({ assign: merge } = Object);
const box = { load: console.log };

merge(box, { load: require });
box.load(provider);
