export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const context = { slots };
[0].forEach(function () {
  this.slots.unshift(require);
}, context);
slots[0](provider);
