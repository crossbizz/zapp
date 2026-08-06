export {};

const provider = '@ai-sdk/openai';
const key = 'assign';
const Object = {
  assign: (target: object, _source: object) => target,
};
let merge;
({ [key]: merge } = Object);
const box = { load: console.log };

merge(box, { load: require });
box.load(provider);
