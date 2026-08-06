export {};

const provider = '@ai-sdk/openai';
const box = { load: console.log };

Object.assign(box, { load: console.info }, { load: require });
box.load(provider).createOpenAI({});
