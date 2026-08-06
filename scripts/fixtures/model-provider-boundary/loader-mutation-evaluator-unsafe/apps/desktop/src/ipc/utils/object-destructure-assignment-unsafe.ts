export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias = console.error;
({ 0: alias } = slots).unshift(require);
slots[0](provider);
void alias;
