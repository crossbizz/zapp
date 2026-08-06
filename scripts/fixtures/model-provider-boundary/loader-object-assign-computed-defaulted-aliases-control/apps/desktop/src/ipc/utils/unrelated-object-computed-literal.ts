export {};

const provider = '@ai-sdk/anthropic';
const objectValue = {
  assign: (target: object, _source: object) => target,
};
let merge;
({ ['assign']: merge } = objectValue);
const box = { load: console.info };

merge(box, { load: require });
box.load(provider);
