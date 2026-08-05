export {};

const provider = '@ai-sdk/anthropic';
const utilities = {
  assign: (target: object, _source: object) => target,
};
let merge;
({ assign: merge } = utilities);
const box = { load: console.info };

merge(box, { load: require });
box.load(provider);
