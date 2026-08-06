export {};

declare const unknown: boolean;
const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = slots;
[unknown, true].every((value, index) => {
  if (index) alias = [];
  return value;
});
alias.unshift(require);
slots[0](provider);
