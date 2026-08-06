export {};

function make(value: unknown[]) {
  let box = value;
  return {
    get: () => box,
    set: (next: unknown[]) => {
      box = next;
    },
  };
}

const slots = [console.info];
const armed = make(slots);
const clean = make([]);
clean.set([]);
const alias = armed.get();
alias.unshift(require);
slots[0]('@ai-sdk/openai');
