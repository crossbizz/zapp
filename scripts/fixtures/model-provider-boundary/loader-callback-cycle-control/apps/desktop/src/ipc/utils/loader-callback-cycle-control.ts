const mapped = [console.log].map((value) => value);
const found = [console.log].filter(Boolean).find(Boolean);
const reduced = [console.log].reduce((_accumulator, value) => value);
const box: Record<string, unknown> = {};
box.self = box;
box.callback = console.log;

mapped[0]('@ai-sdk/openai');
found!('@ai-sdk/openai');
reduced('@ai-sdk/openai');
(box.self as typeof box).self.self.callback('@ai-sdk/openai');
