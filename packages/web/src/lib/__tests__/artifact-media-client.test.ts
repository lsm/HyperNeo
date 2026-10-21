import type { MessageHub } from '@hyperneo/shared';
import type { ArtifactFileMetadata } from '@hyperneo/shared/types/artifact-file';
import { describe, expect, it, vi } from 'vitest';
import { downloadArtifact } from '../artifact-media-client.ts';
import { readArtifactPreview } from '../artifact-preview-client.ts';

const bytes = new TextEncoder().encode('{"safe":"<script>inert</script>"}');
async function fixture(kind = 'json', data = bytes) {
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex');
  const metadata = {
    artifact: { artifactId: 'a', title: 'Report', kind, byteLength: data.length },
    sha256,
    sourcePath: 'report.json',
  } as ArtifactFileMetadata;
  const request = vi.fn(async (_method, params): Promise<unknown> => {
    if (params.name === 'artifact.file.get') return { accepted: true, metadata };
    const { offset, maxBytes } = params.input;
    const end = Math.min(offset + maxBytes, data.length);
    return {
      accepted: true,
      data: Buffer.from(data.slice(offset, end)).toString('base64'),
      nextOffset: end,
      byteLength: data.length,
      sha256,
      complete: end === data.length,
    };
  });
  return { hub: { request } as unknown as MessageHub, metadata, request };
}
describe('artifact media previews and downloads', () => {
  it('formats bounded JSON for the reader without interpreting HTML', async () => {
    const { hub } = await fixture();
    const result = await readArtifactPreview(hub, 'a');
    expect(result.state).toBe('ready');
    if (result.state === 'ready')
      expect(result.text).toBe('{\n  "safe": "<script>inert</script>"\n}');
  });
  it.each(['json', 'log', 'image'])(
    'distinguishes transient %s read failure from revoked access',
    async (kind) => {
      const { hub, metadata, request } = await fixture(kind);
      request.mockResolvedValueOnce({ accepted: true, metadata });
      request.mockRejectedValueOnce(new Error('synthetic temporary read failure'));
      expect(await readArtifactPreview(hub, 'a')).toEqual({ state: 'daemon_unavailable' });
    }
  );
  it('removes access only for a typed daemon refusal rather than an error message', async () => {
    const { hub, metadata, request } = await fixture();
    request.mockResolvedValueOnce({ accepted: true, metadata });
    request.mockResolvedValueOnce({ accepted: false, reason: 'unavailable' });
    expect(await readArtifactPreview(hub, 'a')).toEqual({ state: 'revoked' });
    request.mockResolvedValueOnce({ accepted: true, metadata });
    request.mockRejectedValueOnce(new Error('unavailable'));
    expect(await readArtifactPreview(hub, 'a')).toEqual({ state: 'daemon_unavailable' });
  });
  it('shows bounded log head and tail with the exact omitted byte count', async () => {
    const data = new TextEncoder().encode('HEAD\n' + 'x'.repeat(400000) + '\nTAIL');
    const { hub, request } = await fixture('log', data);
    const result = await readArtifactPreview(hub, 'a');
    expect(result.state).toBe('ready');
    if (result.state === 'ready') {
      expect(result.text.startsWith('HEAD')).toBe(true);
      expect(result.text.endsWith('TAIL')).toBe(true);
      expect(result.omittedBytes).toBe(data.length - 262144);
    }
    expect(request.mock.calls.slice(1).reduce((n, c) => n + c[1].input.maxBytes, 0)).toBe(262144);
  });
  it('previews raster bytes but refuses SVG and excessive pixels before browser decoding', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGN41mNDFcQwatCoQaMGjRo0atCoQQNvEADxaMeuOCcmmgAAAABJRU5ErkJggg==',
      'base64'
    );
    const normal = await fixture('image', new Uint8Array(png));
    const result = await readArtifactPreview(normal.hub, 'a');
    expect(result.state).toBe('ready');
    if (result.state === 'ready') expect(result.image?.type).toBe('image/png');
    png.writeUInt32BE(100000, 16);
    png.writeUInt32BE(100000, 20);
    const big = await fixture('image', new Uint8Array(png));
    expect((await readArtifactPreview(big.hub, 'a')).state).toBe('limit');
    const svg = await fixture('image', new TextEncoder().encode('<svg onload="evil()"/>'));
    expect((await readArtifactPreview(svg.hub, 'a')).state).toBe('unsupported');
  });
  it('does not request the next chunk until the consumer is ready', async () => {
    const { hub, metadata, request } = await fixture('log', new Uint8Array(600000));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = vi.fn(async () => {
      await pending;
    });
    const transfer = downloadArtifact(hub, metadata, new AbortController().signal, writing);
    await vi.waitFor(() => expect(writing).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledTimes(1);
    release();
    await transfer;
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('reauthorizes even an empty download', async () => {
    const { hub, metadata, request } = await fixture('log', new Uint8Array());
    await downloadArtifact(hub, metadata, new AbortController().signal, async () => {});
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('downloads all chunks, verifies the hash, and awaits the consumer before reading again', async () => {
    const data = new Uint8Array(600000).fill(42);
    const { hub, metadata, request } = await fixture('log', data);
    const parts: Uint8Array[] = [];
    await downloadArtifact(hub, metadata, new AbortController().signal, async (part) => {
      parts.push(part);
    });
    expect(Buffer.concat(parts).equals(Buffer.from(data))).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('verifies downloads when Web Crypto is unavailable on plain HTTP', async () => {
    const { hub, metadata } = await fixture();
    vi.stubGlobal('crypto', undefined);
    try {
      await downloadArtifact(hub, metadata, new AbortController().signal, async () => {});
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('cancels between chunks without completing a file', async () => {
    const { hub, metadata, request } = await fixture('log', new Uint8Array(600000));
    const controller = new AbortController();
    await expect(
      downloadArtifact(hub, metadata, controller.signal, async () => {
        controller.abort();
      })
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('refuses tampered bytes rather than producing a complete download', async () => {
    const { hub, metadata } = await fixture();
    await expect(
      downloadArtifact(
        hub,
        { ...metadata, sha256: '0'.repeat(64) },
        new AbortController().signal,
        async () => {}
      )
    ).rejects.toThrow();
  });
});
