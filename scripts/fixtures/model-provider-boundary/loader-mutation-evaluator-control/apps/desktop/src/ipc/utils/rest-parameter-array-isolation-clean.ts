export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
function arm(...values: unknown[][]) {
  values.unshift([require]);
}
arm(slots);
slots[0](provider);
