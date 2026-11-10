import { createHash } from 'node:crypto';
import type { MessageHub } from '@hyperneo/shared';
import { describe, expect, it, vi } from 'vitest';
import { downloadArtifact } from '../artifact-media-client.ts';
import { readArtifactPreview } from '../artifact-preview-client.ts';
import { readLiveFile } from '../live-file-client.ts';

function movie(brand = 'mp42', length = 600007) {
  const bytes = Buffer.alloc(length, 0x55);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftyp', 4);
  bytes.write(brand, 8);
  bytes.writeUInt32BE(0, 12);
  bytes.write(brand, 16);
  bytes.write(brand, 20);
  return bytes;
}
function fixture(bytes: Buffer, path = 'clip.mp4') {
  const metadata = {
    artifact: { artifactId: 'video', title: path, kind: 'video', byteLength: bytes.length },
    sourcePath: path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const request = vi.fn(async (_method, { name, input }) => {
    if (name === 'artifact.file.get') return { accepted: true, metadata };
    const nextOffset = Math.min(bytes.length, input.offset + input.maxBytes);
    return {
      accepted: true,
      data: bytes.subarray(input.offset, nextOffset).toString('base64'),
      sha256: metadata.sha256,
      byteLength: metadata.artifact.byteLength,
      nextOffset,
      complete: nextOffset === bytes.length,
      kind: 'video',
      mediaType: path.endsWith('.mov') ? 'video/quicktime' : 'video/mp4',
      version: 'a'.repeat(64),
    };
  });
  return { hub: { request } as unknown as MessageHub, request, metadata };
}
const target = (reference = 'clip.mp4') => ({
  kind: 'reference' as const,
  source: { kind: 'publication' as const, id: 'visible' },
  reference,
});

describe('video preview collectors', () => {
  it('caps video downloads before any byte request or write', async () => {
    const { hub, request, metadata } = fixture(movie());
    metadata.artifact.byteLength = 16 * 1024 * 1024 + 1;
    const write = vi.fn();
    await expect(
      downloadArtifact(
        hub,
        metadata as Parameters<typeof downloadArtifact>[1],
        new AbortController().signal,
        write
      )
    ).rejects.toMatchObject({ reason: 'size_limit' });
    expect(request).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it.each([
    ['mp42', 'clip.mp4', 'video/mp4'],
    ['qt  ', 'clip.mov', 'video/quicktime'],
  ])(
    'verifies a registered %s container before returning a typed video Blob',
    async (brand, path, type) => {
      const { hub, request } = fixture(movie(brand), path);
      const result = await readArtifactPreview(hub, 'video');
      expect(result).toMatchObject({ state: 'ready', text: '', video: { type, size: 600007 } });
      expect(request).toHaveBeenCalledTimes(4);
    }
  );
  it('refuses oversized registered video before requesting any bytes', async () => {
    const { hub, request, metadata } = fixture(movie());
    metadata.artifact.byteLength = 16 * 1024 * 1024 + 1;
    expect((await readArtifactPreview(hub, 'video')).state).toBe('limit');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects a registered video whose complete bytes fail the snapshot hash', async () => {
    const { hub, request, metadata } = fixture(movie());
    metadata.sha256 = '0'.repeat(64);
    expect((await readArtifactPreview(hub, 'video')).state).toBe('daemon_unavailable');
    expect(request).toHaveBeenCalledTimes(4);
  });
  it('stops registered video reads after cancellation between chunks', async () => {
    const { hub, request } = fixture(movie());
    const controller = new AbortController();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].name === 'artifact.file.read') controller.abort();
      return result;
    });
    expect((await readArtifactPreview(hub, 'video', controller.signal)).state).not.toBe('ready');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('returns binary live video above the document limit without decoding it as text', async () => {
    const bytes = movie('mp42', 3 * 1024 * 1024);
    const { hub } = fixture(bytes);
    const result = await readLiveFile(hub, target(), new AbortController().signal);
    expect(result.kind).toBe('video');
    expect(result.text).toBe('');
    expect(result.blob.type).toBe('video/mp4');
    expect(Buffer.from(await result.blob.arrayBuffer()).equals(bytes)).toBe(true);
  });
  it('uses the resolved path for an encoded live file reference', async () => {
    const { hub, request } = fixture(movie());
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      path: '/synthetic/clip.mp4',
    }));
    const result = await readLiveFile(
      hub,
      target('file:///synthetic/clip%2Emp4'),
      new AbortController().signal
    );
    expect(result.blob.type).toBe('video/mp4');
  });
  it('refuses a live video above 16 MiB', async () => {
    const { hub, metadata } = fixture(movie());
    metadata.artifact.byteLength = 16 * 1024 * 1024 + 1;
    await expect(readLiveFile(hub, target(), new AbortController().signal)).rejects.toThrow(
      'size_limit'
    );
  });
  it('refuses a mismatched live container header', async () => {
    const { hub } = fixture(movie('qt  '));
    await expect(readLiveFile(hub, target(), new AbortController().signal)).rejects.toThrow(
      'unsupported_type'
    );
  });
});
