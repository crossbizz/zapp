const box: Record<string, unknown> = {};
box.self = box;
box.load = require;

(box.self as typeof box).self.self.load('@ai-sdk/openai').createOpenAI({});
