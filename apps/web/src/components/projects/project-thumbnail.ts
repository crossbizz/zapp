const allowedThumbnailTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface EncodedProjectThumbnail {
  readonly thumbnail: {
    readonly content: string;
    readonly contentHash: string;
    readonly contentType: string;
    readonly encoding: string;
  };
}

export function decodeThumbnail(response: EncodedProjectThumbnail): Blob {
  if (
    response.thumbnail.encoding !== 'base64'
    || !allowedThumbnailTypes.has(response.thumbnail.contentType)
  ) {
    throw new Error('Unsupported project thumbnail payload.');
  }
  const decoded = globalThis.atob(response.thumbnail.content);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: response.thumbnail.contentType });
}

export function revokeThumbnail(
  url: string,
  revoke: (objectUrl: string) => void = (objectUrl) => {
    URL.revokeObjectURL(objectUrl);
  },
): void {
  revoke(url);
}
