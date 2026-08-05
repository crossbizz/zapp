function identity<T>(value: T): T {
  return value;
}

const pass = identity;
const callbacks = { text: (value: string) => value.toUpperCase() };
const callbackList = [callbacks.text];
let callback = (value: string) => value;
callback = callbackList[0];
pass(callback)('safe');
