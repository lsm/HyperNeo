export type NeoImageSize = { width: number; height: number };

const size = (width: number, height: number): NeoImageSize | null =>
  width > 0 && height > 0 ? { width, height } : null;

function pngSize(bytes: Uint8Array, view: DataView): NeoImageSize | null {
  return bytes.length >= 24 ? size(view.getUint32(16), view.getUint32(20)) : null;
}

function gifSize(bytes: Uint8Array, view: DataView): NeoImageSize | null {
  return bytes.length >= 10 ? size(view.getUint16(6, true), view.getUint16(8, true)) : null;
}

function jpegSize(bytes: Uint8Array, view: DataView): NeoImageSize | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = view.getUint16(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return size(view.getUint16(at + 7), view.getUint16(at + 5));
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array, view: DataView): NeoImageSize | null {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X')
    return size(
      1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    );
  if (chunk === 'VP8L')
    return size(
      1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
      1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6))
    );
  if (chunk === 'VP8 ')
    return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  return null;
}

const HEADER_BASE64_CHARS = 262_144;

export function neoImageSize(base64: string): NeoImageSize | null {
  try {
    const bytes = Buffer.from(base64.slice(0, HEADER_BASE64_CHARS), 'base64');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngSize(bytes, view);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes, view);
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return gifSize(bytes, view);
    if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF') return webpSize(bytes, view);
    return null;
  } catch {
    return null;
  }
}
