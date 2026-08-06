export {};

const slots = [console.info];
let alias: unknown[] = [];
const clean = { slots: [] as unknown[] };
const holder = {
  slots,
  run() {
    [0].forEach(() => {
      alias = this.slots;
    }, clean);
  },
};
holder.run();
alias.unshift(require);
slots[0]('@ai-sdk/openai');
