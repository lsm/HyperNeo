import type { MessageHub, MessageImage } from '@hyperneo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  admitNeoDraft,
  createNeoIntakeClient,
  neoDraftPayload,
  neoDraftThumbnails,
  requireNeoReceipt,
  type NeoPendingAsk,
} from '../neo-intake.ts';

const uuid = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const image: MessageImage = { data: 'aGVsbG8=', media_type: 'image/png' };
type Payload = ReturnType<typeof neoDraftPayload>;
const receipt = (requestId: string, created = true) => ({
  ok: true as const,
  requestId,
  messageId: requestId,
  created,
});
function setup() {
  const request = vi.fn(async (_method: string, { input }: { input: Payload }) =>
    receipt(input.requestId)
  );
  const getHub = vi.fn(async () => ({ request }) as unknown as MessageHub);
  return { request, getHub, client: createNeoIntakeClient(getHub) };
}

describe('admitNeoDraft', () => {
  it.each([
    { sessionId: 'neo:root', text: '' },
    { sessionId: 'neo:root', text: '   ', images: [] },
    { sessionId: '', text: 'Hello' },
  ])('rejects an empty or unopened submission: %j', (draft) => {
    expect(admitNeoDraft({ ...draft, requestId: uuid })).toHaveProperty('reason.ok', false);
  });
  it.each([
    { sessionId: 'neo:root', text: 'Hi' },
    { sessionId: 'neo:root', text: '', images: [image] },
  ])('admits text or an image: %j', (draft) => {
    const submission = { ...draft, requestId: uuid };
    expect(admitNeoDraft(submission)).toEqual({ value: submission });
  });
});

describe('neoDraftPayload', () => {
  it('sends the reply text alone and names the quoted message in replyTo', () => {
    expect(
      neoDraftPayload({
        sessionId: 'neo:root',
        requestId: uuid,
        text: 'Please explain',
        quote: {
          author: 'Neo',
          text: '**Answer**\r\n\r\n> nested\n```js\ncode\n```',
          anchor: 'neo-message-source',
          replyTo: { kind: 'message', id: 'publication-1' },
        },
      })
    ).toEqual({
      sessionId: 'neo:root',
      requestId: uuid,
      content: 'Please explain',
      replyTo: { kind: 'message', id: 'publication-1' },
    });
  });

  it('sends an image-only reply without inventing quote text', () => {
    const payload = neoDraftPayload(
      {
        sessionId: 'neo:root',
        requestId: uuid,
        text: '',
        images: [image],
        quote: {
          author: 'You',
          text: 'Which photo?',
          anchor: 'neo-message-question',
          replyTo: { kind: 'message', id: 'request-1' },
        },
      },
      [{ index: 1, mediaType: 'image/jpeg', data: 'thumb' }]
    );
    expect(payload).toEqual({
      sessionId: 'neo:root',
      requestId: uuid,
      replyTo: { kind: 'message', id: 'request-1' },
      content: [
        {
          type: 'image',
          source: { type: 'base64', data: image.data, media_type: image.media_type },
        },
      ],
      thumbnails: [{ index: 1, mediaType: 'image/jpeg', data: 'thumb' }],
    });
  });
  it('keeps text-file Markdown as exact source content', () => {
    const text = '  ### Attached file: notes.md\n\n```text\nHello\n```  ';
    expect(neoDraftPayload({ sessionId: 'neo:root', requestId: uuid, text })).toEqual({
      sessionId: 'neo:root',
      requestId: uuid,
      content: text,
    });
  });
  it.each(['', '  ', 'Please inspect'])(
    'builds image content blocks without invented text: %j',
    (text) => {
      const blocks = neoDraftPayload({
        sessionId: 'neo:root',
        requestId: uuid,
        text,
        images: [image],
      }).content;
      expect(blocks).toEqual([
        ...(text.trim() ? [{ type: 'text', text }] : []),
        {
          type: 'image',
          source: { type: 'base64', data: image.data, media_type: image.media_type },
        },
      ]);
    }
  );
});

describe('requireNeoReceipt', () => {
  const submission = { sessionId: 'neo:root', requestId: uuid, text: 'Hello' };
  it.each([true, false])('accepts a matching durable receipt with created=%s', (created) => {
    expect(requireNeoReceipt(receipt(uuid, created), submission)).toEqual({
      value: receipt(uuid, created),
    });
  });
  it('returns an owning-subsystem rejection unchanged', () => {
    const rejected = { ok: false, reason: 'This conversation is no longer available.' };
    expect(requireNeoReceipt(rejected, submission)).toEqual({ reason: rejected });
  });
  it.each([
    undefined,
    null,
    {},
    { ok: true, requestId: uuid, messageId: uuid },
    { ...receipt(uuid), created: 'true' },
    receipt(other),
    { ...receipt(uuid), messageId: other },
    { ok: false },
  ])('cannot accept a malformed or mismatched receipt: %j', (response) => {
    expect(requireNeoReceipt(response, submission)).toHaveProperty('reason.ok', false);
  });
});

describe('Neo intake submission lifecycle', () => {
  it('detaches a nested quote target before asynchronous send preparation', async () => {
    const { client, request } = setup();
    const quote = {
      author: 'Neo' as const,
      text: 'Original quote',
      anchor: 'source',
      replyTo: { kind: 'message' as const, id: 'original-message' },
    };
    const pending = client.send({ sessionId: 'neo:root', text: 'Reply', quote });
    quote.replyTo.id = 'different-message';
    await pending;
    expect(request.mock.calls[0][1].input.replyTo).toEqual({
      kind: 'message',
      id: 'original-message',
    });
  });

  it('retries the original nested target after the caller changes it', async () => {
    const { client, request } = setup();
    request.mockRejectedValue(new Error('offline'));
    const quote = {
      author: 'Neo' as const,
      text: 'Original quote',
      anchor: 'source',
      replyTo: { kind: 'message' as const, id: 'original-message' },
    };
    await expect(client.send({ sessionId: 'neo:root', text: 'Reply', quote })).rejects.toThrow(
      'offline'
    );
    const first = structuredClone(request.mock.calls[0][1].input);
    quote.replyTo.id = 'different-message';
    await expect(client.retry(first.requestId)).rejects.toThrow('offline');
    expect(request.mock.calls[1][1].input).toEqual(first);
  });

  it('isolates pending display snapshots from retained retry payloads', async () => {
    const { request, getHub } = setup();
    request.mockRejectedValue(new Error('offline'));
    let shown: readonly NeoPendingAsk[] = [];
    const client = createNeoIntakeClient(getHub, (asks) => {
      shown = asks;
    });
    const context = {
      artifactId: 'original-report',
      snapshot: 'a'.repeat(64),
      displayName: 'Original report',
      state: 'available' as const,
    };
    await expect(
      client.send({
        sessionId: 'neo:root',
        text: 'Reply',
        images: [{ ...image }],
        quote: {
          author: 'Neo',
          text: 'Original quote',
          anchor: 'source',
          replyTo: { kind: 'message', id: 'original-message' },
        },
        previewContext: context,
      })
    ).rejects.toThrow('offline');
    const first = structuredClone(request.mock.calls[0][1].input);
    shown[0].quote!.text = 'Changed display quote';
    shown[0].quote!.replyTo!.id = 'different-message';
    shown[0].images[0].data = 'Y2hhbmdlZA==';
    Object.assign(shown[0].previewContext!, { snapshot: 'b'.repeat(64) });
    await expect(client.retry(first.requestId)).rejects.toThrow('offline');
    expect(request.mock.calls[1][1].input).toEqual(first);
  });

  it.each([
    { kind: 'todo' as const },
    { id: 'different-message' },
    { author: 'user' as const },
    { excerpt: 'Different excerpt' },
    { replyTo: undefined },
  ])('gives a changed nested quote target its own request identity: %j', async (change) => {
    const { client, request } = setup();
    request.mockRejectedValue(new Error('offline'));
    const quote = {
      author: 'Neo' as const,
      text: 'Original quote',
      anchor: 'source',
      replyTo: {
        kind: 'message' as const,
        id: 'original-message',
        author: 'neo' as const,
        excerpt: 'Original excerpt',
      },
    };
    const draft = { sessionId: 'neo:root', text: 'Reply', quote };
    await expect(client.send(draft)).rejects.toThrow('offline');
    const first = request.mock.calls[0][1].input.requestId;
    const replyTo = 'replyTo' in change ? undefined : { ...quote.replyTo, ...change };
    await expect(client.send({ ...draft, quote: { ...quote, replyTo } })).rejects.toThrow(
      'offline'
    );
    expect(request.mock.calls[1][1].input.requestId).not.toBe(first);
    await expect(client.send({ ...draft, quote: { ...quote, replyTo } })).rejects.toThrow(
      'offline'
    );
    expect(request.mock.calls[2][1].input.requestId).toBe(request.mock.calls[1][1].input.requestId);
  });

  it('snapshots quote context and gives different sources different retry identities', async () => {
    const { client, request } = setup();
    request.mockRejectedValue(new Error('offline'));
    const quote = { author: 'Neo' as const, text: 'Original', anchor: 'source-1' };
    const draft = { sessionId: 'neo:root', text: 'Explain', quote };
    await expect(client.send(draft)).rejects.toThrow('offline');
    const first = request.mock.calls[0][1].input;
    quote.text = 'Changed after submission';
    await expect(client.retry(first.requestId)).rejects.toThrow('offline');
    expect(request.mock.calls[1][1].input).toEqual(first);
    await expect(
      client.send({ ...draft, quote: { ...quote, text: 'Original', anchor: 'source-2' } })
    ).rejects.toThrow('offline');
    expect(request.mock.calls[2][1].input.requestId).not.toBe(first.requestId);
    expect(client.discard(first.requestId)).toEqual({
      sessionId: 'neo:root',
      text: 'Explain',
      images: undefined,
      quote: { author: 'Neo', text: 'Original', anchor: 'source-1' },
    });
  });

  it('does not admit a quote alone as a new message', async () => {
    const { client, request } = setup();
    expect(
      await client.send({
        sessionId: 'neo:root',
        text: '',
        quote: { author: 'You', text: 'Earlier', anchor: 'source' },
      })
    ).toHaveProperty('ok', false);
    expect(request).not.toHaveBeenCalled();
  });
  it('sends on a plain-HTTP page where crypto.randomUUID is missing', async () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    try {
      const { client, request } = setup();
      await expect(client.send({ sessionId: 'neo:root', text: 'Hi' })).resolves.toHaveProperty(
        'ok',
        true
      );
      expect(request.mock.calls[0][1].input.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        value: original,
        configurable: true,
      });
    }
  });

  it('does not connect for an empty ask', async () => {
    const { client, getHub, request } = setup();
    expect(await client.send({ sessionId: 'neo:root', text: '  ' })).toHaveProperty('ok', false);
    expect(getHub).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('uses operation intake for image-only content and returns the matching receipt', async () => {
    const { client, request } = setup();
    const result = await client.send({ sessionId: 'neo:root', text: '', images: [image] });
    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      'operation.invoke',
      {
        name: 'neo.message.send',
        input: {
          sessionId: 'neo:root',
          requestId: result.ok ? result.requestId : '',
          content: [
            {
              type: 'image',
              source: { type: 'base64', data: image.data, media_type: image.media_type },
            },
          ],
        },
      },
      { timeout: 90_000 }
    );
  });
  it('retains the same UUID after an uncertain transport failure', async () => {
    const { client, request } = setup();
    request.mockRejectedValueOnce(new Error('Disconnected'));
    const draft = { sessionId: 'neo:root', text: 'Project A?' };
    await expect(client.send(draft)).rejects.toThrow('Disconnected');
    expect((await client.send(draft)).ok).toBe(true);
    expect(request.mock.calls[1][1].input.requestId).toBe(request.mock.calls[0][1].input.requestId);
  });
  it.each(['', '   '])('a rejected draft cannot evict an uncertain ask: %j', async (text) => {
    const mint = vi.spyOn(crypto, 'randomUUID');
    const { client, request } = setup();
    const draft = { sessionId: 'neo:root', text: 'Project A?' };
    try {
      request.mockRejectedValueOnce(new Error('Disconnected'));
      await expect(client.send(draft)).rejects.toThrow('Disconnected');
      expect(await client.send({ ...draft, text, images: [] })).toHaveProperty('ok', false);
      expect(request).toHaveBeenCalledTimes(1);
      expect((await client.send(draft)).ok).toBe(true);
      expect(request.mock.calls[1][1].input.requestId).toBe(
        request.mock.calls[0][1].input.requestId
      );
      expect(mint).toHaveBeenCalledTimes(1);
    } finally {
      mint.mockRestore();
    }
  });
  it('retains identity after connection acquisition fails', async () => {
    const mint = vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid);
    const { request, getHub, client } = setup();
    try {
      getHub.mockRejectedValueOnce(new Error('Cannot connect'));
      const draft = { sessionId: 'neo:root', text: 'Project A?' };
      await expect(client.send(draft)).rejects.toThrow('Cannot connect');
      expect((await client.send(draft)).ok).toBe(true);
      expect(getHub).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenCalledTimes(1);
      expect(mint).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][1].input.requestId).toBe(uuid);
    } finally {
      mint.mockRestore();
    }
  });
  it.each(['rejected', 'malformed', 'mismatched'] as const)(
    'does not discard identity on %s receipt',
    async (kind) => {
      const { client, request } = setup();
      request.mockImplementationOnce(
        async () =>
          (kind === 'rejected'
            ? { ok: false, reason: 'Try again' }
            : kind === 'malformed'
              ? {}
              : receipt(other)) as ReturnType<typeof receipt>
      );
      const draft = { sessionId: 'neo:root', text: 'Project A?' };
      expect((await client.send(draft)).ok).toBe(false);
      expect((await client.send(draft)).ok).toBe(true);
      expect(request.mock.calls[1][1].input.requestId).toBe(
        request.mock.calls[0][1].input.requestId
      );
    }
  );
  it('mints a new identity for an intentionally repeated accepted ask', async () => {
    const { client, request } = setup();
    const draft = { sessionId: 'neo:root', text: 'Status?' };
    await client.send(draft);
    await client.send(draft);
    expect(request.mock.calls[1][1].input.requestId).not.toBe(
      request.mock.calls[0][1].input.requestId
    );
  });
  it('settles the captured session even if the caller mutates its draft', async () => {
    const { client, request } = setup();
    const draft = { sessionId: 'neo:root', text: 'Status?' };
    const first = client.send(draft);
    draft.sessionId = 'neo:holder';
    await first;
    await client.send({ sessionId: 'neo:root', text: 'Status?' });
    expect(request.mock.calls[0][1].input.sessionId).toBe('neo:root');
    expect(request.mock.calls[1][1].input.requestId).not.toBe(
      request.mock.calls[0][1].input.requestId
    );
  });
  it('keeps independent sessions and edits separate', async () => {
    const { client, request } = setup();
    request.mockRejectedValue(new Error('Disconnected'));
    for (const draft of [
      { sessionId: 'neo:root', text: 'A' },
      { sessionId: 'neo:holder', text: 'A' },
      { sessionId: 'neo:root', text: 'B' },
    ])
      await expect(client.send(draft)).rejects.toThrow('Disconnected');
    expect(new Set(request.mock.calls.map((call) => call[1].input.requestId)).size).toBe(3);
  });
  it('captures immutable attachment data for retry comparison', async () => {
    const { client, request } = setup();
    request.mockRejectedValue(new Error('Disconnected'));
    const photo = { ...image };
    const draft = { sessionId: 'neo:root', text: '', images: [photo] };
    await expect(client.send(draft)).rejects.toThrow('Disconnected');
    photo.data = 'd29ybGQ=';
    await expect(client.send(draft)).rejects.toThrow('Disconnected');
    expect(request.mock.calls[1][1].input.requestId).not.toBe(
      request.mock.calls[0][1].input.requestId
    );
    expect(request.mock.calls[0][1].input.content).toEqual([
      { type: 'image', source: { type: 'base64', data: image.data, media_type: image.media_type } },
    ]);
  });
  it('deduplicates an identical in-flight call but does not block an unrelated ask', async () => {
    const { client, request } = setup();
    let settle: (value: ReturnType<typeof receipt>) => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const draft = { sessionId: 'neo:root', text: 'A' };
    const first = client.send(draft);
    expect(await client.send({ ...draft, text: '  ', images: [] })).toHaveProperty('ok', false);
    const retry = client.send(draft);
    expect(retry).toBe(first);
    const independent = client.send({ ...draft, text: 'B' });
    expect(client.send(draft)).toBe(first);
    expect((await independent).ok).toBe(true);
    expect(client.send(draft)).toBe(first);
    expect(request).toHaveBeenCalledTimes(2);
    settle(receipt(request.mock.calls[0][1].input.requestId));
    expect(await first).toEqual(await retry);
  });
  it('a late acceptance cannot clear a newer uncertain ask', async () => {
    const { client, request } = setup();
    let settle: (value: ReturnType<typeof receipt>) => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    request.mockRejectedValueOnce(new Error('Disconnected'));
    const first = client.send({ sessionId: 'neo:root', text: 'A' });
    const second = { sessionId: 'neo:root', text: 'B' };
    await expect(client.send(second)).rejects.toThrow('Disconnected');
    expect(client.send({ sessionId: 'neo:root', text: 'A' })).toBe(first);
    const secondId = request.mock.calls[1][1].input.requestId;
    settle(receipt(request.mock.calls[0][1].input.requestId));
    await first;
    await client.send(second);
    expect(request.mock.calls[2][1].input.requestId).toBe(secondId);
  });
});

describe('createNeoIntakeClient pending asks', () => {
  function tracked() {
    const seen: string[][] = [];
    const request = vi.fn(async (_method: string, { input }: { input: Payload }) =>
      receipt(input.requestId)
    );
    const getHub = vi.fn(async () => ({ request }) as unknown as MessageHub);
    const client = createNeoIntakeClient(getHub, (asks) =>
      seen.push(asks.map((ask) => `${ask.text}:${ask.state}`))
    );
    return { request, client, seen };
  }

  it('shows an ask as sending at once, then accepted until the ledger has it', async () => {
    const { client, seen } = tracked();
    const flight = client.send({ sessionId: 'neo:root', text: 'Hello' });
    expect(seen.at(-1)).toEqual(['Hello:sending']);
    const result = await flight;
    expect(seen.at(-1)).toEqual(['Hello:accepted']);
    client.settle(new Set(['someone-else']));
    expect(seen.at(-1)).toEqual(['Hello:accepted']);
    client.settle(new Set([result.ok ? result.requestId : '']));
    expect(seen.at(-1)).toEqual([]);
  });

  it('marks a rejected ask failed, retries it with the same request id, and discards on edit', async () => {
    const { client, request, seen } = tracked();
    request.mockResolvedValueOnce({ ok: false, reason: 'Busy' } as never);
    await client.send({ sessionId: 'neo:root', text: 'Hello' });
    expect(seen.at(-1)).toEqual(['Hello:failed']);
    const firstId = request.mock.calls[0][1].input.requestId;
    request.mockResolvedValueOnce({ ok: false, reason: 'Still busy' } as never);
    await client.retry(firstId);
    expect(request.mock.calls[1][1].input.requestId).toBe(firstId);
    expect(client.discard(firstId)).toEqual({
      sessionId: 'neo:root',
      text: 'Hello',
      images: undefined,
    });
    expect(seen.at(-1)).toEqual([]);
    expect(client.retry(firstId)).toBeNull();
  });

  it('marks a thrown send failed and still rejects for the caller', async () => {
    const { client, request, seen } = tracked();
    request.mockRejectedValueOnce(new Error('Connection failed'));
    await expect(client.send({ sessionId: 'neo:root', text: 'Hello' })).rejects.toThrow(
      'Connection failed'
    );
    expect(seen.at(-1)).toEqual(['Hello:failed']);
  });
});

describe('Neo photo thumbnails', () => {
  const bad: MessageImage = { data: 'YmFk', media_type: 'image/png' };
  function canvas(sizes: number[] = [100], photo = { width: 1024, height: 512 }) {
    const qualities: number[] = [];
    const drawn: number[][] = [];
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) => {
        if (blob.size === 3) throw new Error('undecodable');
        return { ...photo, close: vi.fn() };
      })
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(
          readonly width: number,
          readonly height: number
        ) {}
        getContext() {
          return {
            fillRect: () => {},
            drawImage: (_bitmap: unknown, ...box: number[]) => drawn.push(box),
          };
        }
        async convertToBlob({ quality }: { type: string; quality: number }) {
          qualities.push(quality);
          const size = sizes[Math.min(qualities.length - 1, sizes.length - 1)];
          return new Blob([new Uint8Array(size)], { type: 'image/jpeg' });
        }
      }
    );
    return { qualities, drawn };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a 256 px JPEG thumbnail at each photo’s content index with its natural size', async () => {
    const { qualities, drawn } = canvas();
    const submission = {
      sessionId: 'neo:root',
      requestId: uuid,
      text: 'Look',
      images: [image, image],
    };
    const thumbnails = await neoDraftThumbnails(submission);
    const data = btoa(String.fromCharCode(...new Uint8Array(100)));
    const thumb = { mediaType: 'image/jpeg', data, width: 1024, height: 512 };
    expect(thumbnails).toEqual([
      { index: 1, ...thumb },
      { index: 2, ...thumb },
    ]);
    expect(drawn[0]).toEqual([0, 0, 256, 128]);
    expect(qualities).toEqual([0.7, 0.7]);
    expect(neoDraftPayload(submission, thumbnails)).toEqual({
      ...neoDraftPayload(submission),
      thumbnails,
    });
    expect(neoDraftPayload({ ...submission, images: [] }, thumbnails)).not.toHaveProperty(
      'thumbnails'
    );
  });

  it('leaves out a photo size beyond what the daemon accepts', async () => {
    canvas([100], { width: 200_000, height: 10 });
    const [thumbnail] = await neoDraftThumbnails({
      sessionId: 'neo:root',
      requestId: uuid,
      text: '',
      images: [image],
    });
    expect(thumbnail).not.toHaveProperty('width');
    expect(thumbnail).not.toHaveProperty('height');
  });

  it('lowers quality until the thumbnail fits, and skips one that never fits', async () => {
    const { qualities } = canvas([30_000, 25_000, 20_000]);
    const [fitted] = await neoDraftThumbnails({
      sessionId: 'neo:root',
      requestId: uuid,
      text: '',
      images: [image],
    });
    expect(qualities).toEqual([0.7, 0.5, 0.3]);
    expect(fitted.index).toBe(0);
    expect(fitted.data.length).toBeLessThanOrEqual(32 * 1024);
    canvas([30_000]);
    expect(
      await neoDraftThumbnails({
        sessionId: 'neo:root',
        requestId: uuid,
        text: '',
        images: [image],
      })
    ).toEqual([]);
  });

  it('skips a photo whose thumbnail fails and still sends every photo', async () => {
    canvas();
    const { client, request } = setup();
    const result = await client.send({ sessionId: 'neo:root', text: '', images: [bad, image] });
    expect(result.ok).toBe(true);
    const input = request.mock.calls[0][1].input;
    expect(input.content).toHaveLength(2);
    expect(input.thumbnails).toEqual([expect.objectContaining({ index: 1 })]);
  });

  it('sends without thumbnails when none can be made, as on a page without a canvas', async () => {
    const { client, request } = setup();
    expect((await client.send({ sessionId: 'neo:root', text: 'Hi', images: [image] })).ok).toBe(
      true
    );
    expect(request.mock.calls[0][1].input).not.toHaveProperty('thumbnails');
  });

  it('retries with identical content and thumbnails under the same request id', async () => {
    canvas();
    const { client, request } = setup();
    request.mockRejectedValueOnce(new Error('Disconnected'));
    const draft = { sessionId: 'neo:root', text: 'Look', images: [image] };
    await expect(client.send(draft)).rejects.toThrow('Disconnected');
    expect((await client.send(draft)).ok).toBe(true);
    const [first, second] = request.mock.calls.map((call) => call[1].input);
    expect(second).toEqual(first);
    expect(first.thumbnails).toEqual([expect.objectContaining({ index: 1 })]);
    expect(vi.mocked(createImageBitmap)).toHaveBeenCalledTimes(1);
  });
});
