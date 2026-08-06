let rest = { nested: { load: console.log } };

({
  keep: {},
  ...rest
} = { keep: {}, nested: { load: require } });
rest.nested.load('@ai-sdk/openai').createOpenAI({});
