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
  const request = vi.fn(async (_method, params) => {
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
