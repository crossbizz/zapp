export {};

const slots = [console.info];
const values = [0];
values.forEach = () => void slots.unshift(require);
values.forEach(() => {});
slots[0]('@ai-sdk/openai');
