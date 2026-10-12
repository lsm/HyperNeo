import type { MessageHub, MessageImage } from '@hyperneo/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  admitNeoDraft,
  createNeoIntakeClient,
  neoDraftPayload,
  requireNeoReceipt,
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
