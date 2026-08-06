export {};

const box = {};
const assign = Object.assign;
const { assign: merge } = Object;

assign(box, { load: console.log });
merge(box, { inspect: console.info });
box.load('@ai-sdk/openai');
box.inspect('@ai-sdk/anthropic');
