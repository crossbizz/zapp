export {};

function make(value: unknown[]) {
  const box = { value };
  return () => box;
}

const slots = [console.info];
const getArmed = make(slots);
make([]);
const alias = getArmed().value;
alias.unshift(require);
slots[0]('@ai-sdk/openai');
