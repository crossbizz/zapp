export const maximumImages = 10;
export const maximumImageBytes = 8 * 1024 * 1024;

const supportedImageTypes = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

export interface ImageSelection<T> {
  readonly accepted: readonly T[];
  readonly error?: string;
  readonly results: readonly boolean[];
}

export function selectImageFiles<T extends { readonly file: File }>(
  currentCount: number,
  inputs: readonly T[],
): ImageSelection<T> {
  let available = Math.max(0, maximumImages - currentCount);
  let exceededCapacity = false;
  let unsupported = false;
  let invalidSize = false;
  const accepted: T[] = [];
  const results: boolean[] = [];
  for (const input of inputs) {
    if (!supportedImageTypes.has(input.file.type)) {
      unsupported = true;
      results.push(false);
      continue;
    }
    if (input.file.size <= 0 || input.file.size > maximumImageBytes) {
      invalidSize = true;
      results.push(false);
      continue;
    }
    if (available <= 0) {
      exceededCapacity = true;
      results.push(false);
      continue;
    }
    available -= 1;
    results.push(true);
    accepted.push(input);
  }
  return {
    accepted,
    ...(exceededCapacity
      ? { error: 'You can attach up to 10 images.' }
      : unsupported
        ? { error: 'Use PNG, JPEG, WebP, or GIF images.' }
        : invalidSize
          ? { error: 'Each image must be between 1 byte and 8 MiB.' }
          : {}),
    results,
  };
}
