const callbacks = [console.log];
const flattened = callbacks.flatMap((callback) => [callback]);

callbacks.some((callback) => callback('@ai-sdk/openai'));
callbacks.every((callback) => callback('@ai-sdk/openai'));
callbacks.forEach((callback) => callback('@ai-sdk/openai'));
callbacks.reduce((callback) => callback, console.info)('@ai-sdk/openai');
flattened[0]('@ai-sdk/openai');
