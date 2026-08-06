export {};

const cycle: any = {};
cycle.self = cycle;
cycle.payload = {
  branch: {
    nested: {
      ignored: console.log,
      load: require,
    },
  },
};

const {
  self: { payload: { branch: { nested: { ignored: _ignored, ...rest } = {} } = {} } = {} } = {},
} = cycle;
const { load = console.warn } = rest;

load('@ai-sdk/openai').createOpenAI({});
