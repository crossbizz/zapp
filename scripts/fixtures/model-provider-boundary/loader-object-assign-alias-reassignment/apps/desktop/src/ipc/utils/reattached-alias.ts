export {};

const provider = '@ai-sdk/openai';
let merge;
merge = (_target, _source) => undefined;
merge = Object.assign;
const box = { load: console.log };

merge(box, { load: require });
box.load(provider);
