export {};

declare function firstUnknown(): object;
declare function secondUnknown(): object;

const provider = '@ai-sdk/openai';
const box = { load: require };

Object.assign(box, { load: require }, firstUnknown(), { load: require }, secondUnknown(), {
  load: console.info,
});
box.load(provider);
