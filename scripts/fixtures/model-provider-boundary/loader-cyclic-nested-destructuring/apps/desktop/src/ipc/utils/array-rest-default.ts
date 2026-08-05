export {};

const cycle: any = {};
cycle.self = cycle;
cycle.payload = {
  lanes: [console.log, [console.info, { ignored: console.warn, load: require }]],
};

const { self: { payload: { lanes: [, ...tail] = [] } = {} } = {} } = cycle;
const [[, { ignored: _ignored, ...rest } = {}] = []] = tail;
const { load = console.error } = rest;

load('@ai-sdk/openai').createOpenAI({});
