export {};

const cycle: Record<string, unknown> = {};
cycle.self = cycle;

const values: unknown[] = [];
values.push(cycle);
Object.assign(cycle, { load: require });

const copies = [...values];
const selected = (copies[0] as typeof cycle).self as typeof cycle;
(selected as { load: NodeRequire }).load('@ai-sdk/openai').createOpenAI({});
