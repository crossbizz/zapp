export {};

const provider = '@ai-sdk/openai';
const Object = {
  assign: (target: object, _source: object) => target,
};
let assign;
({ assign } = Object);
const box = { load: console.log };

assign(box, { load: require });
box.load(provider);
