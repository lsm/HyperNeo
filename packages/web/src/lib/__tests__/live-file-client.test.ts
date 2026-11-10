import type { MessageHub } from '@hyperneo/shared';
import { describe, expect, it, vi } from 'vitest';
import { isLiveReference, readLiveFile } from '../live-file-client.ts';

const target = {
  kind: 'reference' as const,
  source: { kind: 'publication' as const, id: 'visible', revisionId: 'revision' },
  reference: 'notes.md',
};
const chunk = (text: string, extra = {}) => ({
  accepted: true,
  kind: 'text',
  data: Buffer.from(text).toString('base64'),
  version: 'a'.repeat(64),
  byteLength: Buffer.byteLength(text),
  nextOffset: Buffer.byteLength(text),
  complete: true,
  ...extra,
});
const hub = (request: ReturnType<typeof vi.fn>) => ({ request }) as unknown as MessageHub;

describe('live source-bound file client', () => {
  it('reads a handoff through the stored card, preserves versions, and refuses leaked paths', async () => {
    const reference = {
      type: 'handoff' as const,
      daemonId: 'd',
      artifactId: 'a'.repeat(64),
      sessionId: 'worker',
      name: 'report.md',
      byteLength: 6,
      sha256: 'a'.repeat(64),
    };
    const handoff = {
      kind: 'reference' as const,
      source: { kind: 'question' as const, id: 'question' },
      reference: reference.name,
      handoff: reference,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(chunk('abc', { byteLength: 6, complete: false }))
      .mockResolvedValueOnce(chunk('def', { byteLength: 6, nextOffset: 6 }));
    expect((await readLiveFile(hub(request), handoff, new AbortController().signal)).text).toBe(
      'abcdef'
    );
    expect(request.mock.calls[0][1]).toEqual({
      name: 'file.handoff.read',
      input: { source: handoff.source, reference, offset: 0, maxBytes: 262144, version: undefined },
    });
    expect(request.mock.calls[1][1].input.version).toBe('a'.repeat(64));
    const leaking = vi.fn(async () => chunk('abc', { path: '/synthetic/private' }));
    await expect(readLiveFile(hub(leaking), handoff, new AbortController().signal)).rejects.toThrow(
      'file_changed'
    );
    const wrongSource = { ...handoff, source: { kind: 'todo' as const, id: 'todo' } };
    await expect(
      readLiveFile(hub(request), wrongSource, new AbortController().signal)
    ).rejects.toThrow('forbidden');
  });
  it('assembles bounded UTF-8 chunks with the exact source and version, without registering anything', async () => {
    const bytes = Buffer.from('中文 and current contents');
    const request = vi.fn(async (_method, { input }) => {
      const next = Math.min(bytes.length, input.offset + 2);
      return chunk('', {
        data: bytes.subarray(input.offset, next).toString('base64'),
        byteLength: bytes.length,
        nextOffset: next,
        complete: next === bytes.length,
      });
    });
    const read = await readLiveFile(hub(request), target, new AbortController().signal);
    expect(read.text).toBe(bytes.toString());
    expect(await read.blob.text()).toBe(bytes.toString());
    expect(request.mock.calls[0][1]).toEqual({
      name: 'file.reference.read',
      input: {
        sourceMessageOrCard: target.source,
        reference: 'notes.md',
        offset: 0,
        maxBytes: 262144,
        version: undefined,
      },
    });
    expect(request.mock.calls[1][1].input.version).toBe('a'.repeat(64));
    expect(request.mock.calls.every(([, call]) => call.name === 'file.reference.read')).toBe(true);
  });

  it.each([
    'missing',
    'owner_unavailable',
    'forbidden',
    'unsupported_type',
    'size_limit',
    'safe_open_unavailable',
  ])('keeps the %s refusal instead of falling back to a snapshot', async (reason) => {
    const request = vi.fn(async () => ({ accepted: false, reason }));
    await expect(readLiveFile(hub(request), target, new AbortController().signal)).rejects.toThrow(
      reason
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { version: 'b'.repeat(64) },
    { byteLength: 7 },
    { kind: 'html' },
    { path: '/another/workspace/report.md' },
    { nextOffset: 2 },
    { complete: false },
  ])('discards a changed or inconsistent chunk: %j', async (change) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(chunk('abc', { byteLength: 6, complete: false }))
      .mockResolvedValueOnce(chunk('def', { byteLength: 6, nextOffset: 6, ...change }));
    await expect(readLiveFile(hub(request), target, new AbortController().signal)).rejects.toThrow(
      'file_changed'
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('stops on a stalled cursor or over-limit reply rather than looping or retaining it', async () => {
    for (const [reply, reason] of [
      [chunk('', { byteLength: 6, complete: false }), 'file_changed'],
      [chunk('x', { byteLength: 2 * 1024 * 1024 + 1 }), 'size_limit'],
    ] as const) {
      const request = vi.fn(async () => reply);
      await expect(
        readLiveFile(hub(request), target, new AbortController().signal)
      ).rejects.toThrow(reason);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it('stops fetching after the view closes or loses its connection', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      return chunk('abc', { byteLength: 6, complete: false });
    });
    await expect(readLiveFile(hub(request), target, controller.signal)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps sanitized HTML metadata and original raster bytes for the existing renderers', async () => {
    const links = [{ text: 'Details', href: 'https://example.com' }];
    const html = await readLiveFile(
      hub(vi.fn(async () => chunk('<h1>Safe</h1>', { kind: 'html', links, scriptsRemoved: true }))),
      target,
      new AbortController().signal
    );
    expect(html.html).toEqual({ document: '<h1>Safe</h1>', links, scriptsRemoved: true });
    const image = await readLiveFile(
      hub(vi.fn(async () => chunk('binary', { kind: 'image', mediaType: 'image/png' }))),
      target,
      new AbortController().signal
    );
    expect(image.blob.type).toBe('image/png');
    expect(await image.blob.text()).toBe('binary');
    expect(image.text).toBe('');
  });

  it('keeps legacy IDs and SHA-bound Git references on their separate routes', () => {
    expect(isLiveReference(target)).toBe(true);
    expect(isLiveReference({ ...target, reference: 'file:///synthetic/report.html' })).toBe(true);
    expect(isLiveReference({ kind: 'artifact', artifactId: 'legacy' })).toBe(false);
    expect(
      isLiveReference({ ...target, reference: 'https://github.com/example/demo/pull/1' })
    ).toBe(false);
    expect(
      isLiveReference({ ...target, file: { path: 'notes.md', headSha: 'a'.repeat(40) } })
    ).toBe(false);
  });
});
