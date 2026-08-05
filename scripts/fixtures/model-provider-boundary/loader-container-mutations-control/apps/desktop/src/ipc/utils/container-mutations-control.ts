const cycle: Record<string, unknown> = {};
cycle.self = cycle;

const callbacks: unknown[] = [];
callbacks.push(console.log);
callbacks.unshift(console.info);
Object.assign(cycle, { nested: { callback: console.warn } });

const copies = [...callbacks, cycle];
(copies[0] as typeof console.log)('@ai-sdk/openai');
((copies[2] as typeof cycle).nested as { callback: typeof console.warn }).callback(
  '@ai-sdk/openai',
);
