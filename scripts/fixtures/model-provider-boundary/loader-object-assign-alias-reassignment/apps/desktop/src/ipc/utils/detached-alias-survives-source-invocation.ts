export {};

const provider = '@ai-sdk/openai';
let merge = Object.assign;
const actual = merge;
merge = (_target, _source) => _target;
const box = { load: console.log };

actual(box, { load: require });
merge(box, { load: console.info });
box.load(provider);
