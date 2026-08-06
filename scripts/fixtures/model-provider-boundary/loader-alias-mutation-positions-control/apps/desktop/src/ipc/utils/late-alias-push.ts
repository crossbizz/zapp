export {};

const provider = '@ai-sdk/google';
const slots: Array<NodeRequire | typeof console.info> = [console.info];
let alias: typeof slots;
alias = slots;

alias.push(require);
slots[0](provider);
