export {};

const provider = '@ai-sdk/openai';
const key = 'keys';
let inspect;
({ [key]: inspect } = Object);
const box = { load: console.log };

inspect(box, { load: require });
box.load(provider);
