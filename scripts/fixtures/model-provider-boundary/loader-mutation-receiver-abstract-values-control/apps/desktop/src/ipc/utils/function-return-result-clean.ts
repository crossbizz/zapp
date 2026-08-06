export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
function getDetached() {
  return [];
}
getDetached().unshift(require);
slots[0](provider);
