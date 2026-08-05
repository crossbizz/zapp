export {};

declare function firstUnknown(): object;
declare function secondUnknown(): object;

const provider = '@ai-sdk/openai';
const box = { load: console.info };

Object.assign(box, firstUnknown(), { load: console.warn }, secondUnknown(), { load: require });
box.load(provider);
