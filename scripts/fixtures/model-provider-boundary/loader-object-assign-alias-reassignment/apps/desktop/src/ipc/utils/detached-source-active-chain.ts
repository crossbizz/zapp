export {};

const provider = '@ai-sdk/openai';
let merge;
({ assign: merge } = Object);
const active = merge;
merge = (_target, _source) => undefined;
const box = { load: console.log };

active(box, { load: require });
box.load(provider);
