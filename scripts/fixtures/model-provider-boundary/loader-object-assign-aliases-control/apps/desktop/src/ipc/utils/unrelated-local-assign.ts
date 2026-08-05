export {};

const provider = '@ai-sdk/openai';
const box = {};
const assign = (target: object, _source: object) => target;

assign(box, { load: require });
box.load(provider);
