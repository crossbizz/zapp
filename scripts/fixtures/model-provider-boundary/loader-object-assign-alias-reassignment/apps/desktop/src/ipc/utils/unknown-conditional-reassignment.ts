export {};

declare const enabled: boolean;

const provider = '@ai-sdk/openai';
let merge;
({ assign: merge } = Object);
if (enabled) {
  merge = (_target, _source) => undefined;
}
const box = { load: console.log };

merge(box, { load: require });
box.load(provider);
