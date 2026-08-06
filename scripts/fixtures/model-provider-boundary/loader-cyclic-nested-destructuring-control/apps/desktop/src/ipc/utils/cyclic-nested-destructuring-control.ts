const cycle: any = {};
cycle.self = cycle;
cycle.payload = {
  branch: {
    nested: {
      ignored: console.log,
      callback: console.info,
    },
  },
};

const {
  self: { payload: { branch: { nested: { ignored: _ignored, ...rest } = {} } = {} } = {} } = {},
} = cycle;
const { callback = console.warn } = rest;

callback('@ai-sdk/openai');
