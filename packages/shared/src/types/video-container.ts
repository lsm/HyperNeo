export const VIDEO_MAX_BYTES = 16 * 1024 * 1024;
export const VIDEO_HEADER_BYTES = 1024;

export function videoExtension(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return extension === 'mp4' || extension === 'mov' ? extension : null;
}

export function videoContainerType(bytes: Uint8Array): 'video/mp4' | 'video/quicktime' | null {
  const head = bytes.subarray(0, VIDEO_HEADER_BYTES);
  if (head.length < 16) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const size = view.getUint32(0);
  if (size < 16 || size > head.length || size % 4 !== 0) return null;
  const tag = (offset: number) => String.fromCharCode(...head.subarray(offset, offset + 4));
  if (tag(4) !== 'ftyp') return null;
  const brands = [tag(8)];
  for (let offset = 16; offset < size; offset += 4) brands.push(tag(offset));
  if (brands.includes('qt  ')) return 'video/quicktime';
  return brands.some((brand) => /^(?:mp4[12]|isom|iso[2-9]|avc1|M4V )$/.test(brand))
    ? 'video/mp4'
    : null;
}

export function matchingVideoType(bytes: Uint8Array, path: string) {
  const type = videoContainerType(bytes);
  const extension = videoExtension(path);
  return (extension === 'mp4' && type === 'video/mp4') ||
    (extension === 'mov' && type === 'video/quicktime')
    ? type
    : null;
}
