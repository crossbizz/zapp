const unrelated = {
  call(candidate: unknown, target: string) {
    console.log(candidate, target);
  },
  apply(candidate: unknown, targets: string[]) {
    console.info(candidate, targets);
  },
};

unrelated.call.call(null, require, '@ai-sdk/openai');
unrelated.apply.apply(null, [require, ['@ai-sdk/openai']]);
