export {};

const provider = '@ai-sdk/openai';
let merge;
({ assign: merge } = Object);
({ assign: merge } = {
  assign: (_target, _source) => undefined,
});
const box = { load: console.log };

merge(box, { load: require });
box.load(provider);
