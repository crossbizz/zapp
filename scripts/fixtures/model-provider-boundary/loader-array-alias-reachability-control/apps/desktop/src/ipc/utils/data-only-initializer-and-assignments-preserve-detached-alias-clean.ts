export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
alias = [];
const source = { value: 0 };
const data = { truthy: true, falsy: false, nullish: null };
const unusedFromTernary = data.truthy ? 1 : 0;
let unused: unknown = 0;
unused = data.truthy && 1;
unused = data.falsy || 1;
unused = data.nullish ?? 1;
alias.push(source.value);
alias.unshift(require);
slots[0](provider);
