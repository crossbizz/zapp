function applyWith(callback: (value: string) => string, value: string) {
  return callback(value);
}

applyWith((value) => value.toUpperCase(), 'safe');
