export {};

const provider = '@ai-sdk/anthropic';
const slots: Array<NodeRequire | typeof console.info> = [require];
let alias: typeof slots;
alias = slots;

alias.unshift(console.info);
slots[1](provider).createAnthropic({});
