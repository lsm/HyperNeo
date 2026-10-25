import type { MessageHub } from '@hyperneo/shared';
import type { NeoPreviewReference } from '@hyperneo/shared/types/neo-preview-context';
import { describe, expect, it, vi } from 'vitest';
import { presentConversationAskPage } from '../conversation-ask-client.ts';
import {
  createNeoIntakeClient,
  neoDraftPayload,
  NEO_UNCONFIRMED_RECEIPT,
  requireNeoReceipt,
  submitNeoDraft,
  type NeoPendingAsk,
} from '../neo-intake.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const requestId = '20000000-0000-4000-8000-000000000001';
const reference: NeoPreviewReference = {
  artifactId: 'registered-report',
  snapshot: 'a'.repeat(64),
  displayName: 'Synthetic report',
  state: 'available',
};
const draft = () => ({
  sessionId: `neo:${conversationId}`,
  text: 'Discuss this snapshot.',
  previewContext: { ...reference },
});
const receipt = (id = requestId, context: unknown = reference) => ({
  ok: true,
  requestId: id,
  messageId: id,
  created: true,
  ...(context === undefined ? {} : { previewContext: context }),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Neo Preview client contract', () => {
  it('sends only the exact ID/hash while preserving quote and image payloads', () => {
    const input = {
      ...draft(),
      requestId,
      images: [{ media_type: 'image/png' as const, data: 'aGVsbG8=' }],
      quote: {
        author: 'Neo' as const,
        text: 'Earlier',
        anchor: 'earlier',
        replyTo: { kind: 'message' as const, id: 'publication' },
      },
    };
    expect(neoDraftPayload(input)).toMatchObject({
      previewContext: { artifactId: reference.artifactId, snapshot: reference.snapshot },
      replyTo: input.quote.replyTo,
      content: [{ type: 'text', text: input.text }, { type: 'image' }],
    });
    expect(neoDraftPayload(input)).not.toHaveProperty('previewContext.displayName');
    expect(neoDraftPayload(input)).not.toHaveProperty('previewContext.state');
  });
  it('keeps the canonical display reference from an accepted receipt', () => {
    const canonical = { ...reference, displayName: 'Server title' };
    expect(requireNeoReceipt(receipt(requestId, canonical), { ...draft(), requestId })).toEqual({
      value: receipt(requestId, canonical),
    });
  });
  it.each([
    null,
    { ...reference, artifactId: 'other-file' },
    { ...reference, snapshot: 'b'.repeat(64) },
    { ...reference, state: 'wrong' },
    { ...reference, displayName: '' },
    { ...reference, sourcePath: '/synthetic/private/report.md' },
  ])('does not confirm a mismatched or malformed context %j', (context) => {
    expect(requireNeoReceipt(receipt(requestId, context), { ...draft(), requestId })).toEqual({
      reason: { ok: false, reason: NEO_UNCONFIRMED_RECEIPT },
    });
  });
  it('does not accept a context-free receipt for a bound send or an unexpected binding', () => {
    const ordinary = { ok: true, requestId, messageId: requestId, created: true };
    expect(requireNeoReceipt(ordinary, { ...draft(), requestId })).toHaveProperty('reason');
    expect(
      requireNeoReceipt(receipt(), { sessionId: draft().sessionId, text: 'Plain', requestId })
    ).toHaveProperty('reason');
  });
  it('captures direct pipeline input before asynchronous hub acquisition', async () => {
    const gate = deferred<MessageHub>();
    const request = vi.fn(async () => receipt());
    const input = { ...draft(), requestId };
    const flight = submitNeoDraft(input, () => gate.promise);
    input.previewContext.snapshot = 'b'.repeat(64);
    input.previewContext.artifactId = 'another-file';
    gate.resolve({ request } as unknown as MessageHub);
    expect(await flight).toMatchObject({ ok: true, previewContext: reference });
    expect(request.mock.calls[0]).toMatchObject([
      'operation.invoke',
      {
        input: {
          previewContext: { artifactId: reference.artifactId, snapshot: reference.snapshot },
        },
      },
      { timeout: 90000 },
    ]);
  });
  it.each([false, true])(
    'captures current input when the object is reused, new ID: %s',
    async (newId) => {
      const request = vi.fn(
        async (_method: string, { input }: { input: ReturnType<typeof neoDraftPayload> }) =>
          receipt(input.requestId, { ...reference, ...input.previewContext })
      );
      const hub = async () => ({ request }) as unknown as MessageHub;
      const input = { ...draft(), requestId };
      expect(await submitNeoDraft(input, hub)).toHaveProperty('ok', true);
      input.text = 'A different request';
      input.previewContext = { ...reference, artifactId: 'another-file', snapshot: 'b'.repeat(64) };
      if (newId) input.requestId = '20000000-0000-4000-8000-000000000002';
      expect(await submitNeoDraft(input, hub)).toHaveProperty('ok', true);
      expect(request.mock.calls[1][1].input).toMatchObject({
        requestId: input.requestId,
        content: 'A different request',
        previewContext: { artifactId: 'another-file', snapshot: 'b'.repeat(64) },
      });
      expect(request.mock.calls[0][1].input).toMatchObject({
        requestId,
        content: 'Discuss this snapshot.',
        previewContext: { artifactId: reference.artifactId, snapshot: reference.snapshot },
      });
    }
  );
  it('keeps pending, retry and edit context detached from later draft mutation', async () => {
    const pending: (readonly NeoPendingAsk[])[] = [];
    const request = vi.fn(async () => {
      throw new Error('Disconnected');
    });
    const client = createNeoIntakeClient(
      async () => ({ request }) as unknown as MessageHub,
      (items) => pending.push(items)
    );
    const input = draft();
    await expect(client.send(input)).rejects.toThrow('Disconnected');
    const first = pending.at(-1)![0];
    input.previewContext.snapshot = 'b'.repeat(64);
    input.previewContext.displayName = 'Later title';
    await expect(client.retry(first.requestId)).rejects.toThrow('Disconnected');
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(first).toHaveProperty('previewContext', reference);
    expect(client.discard(first.requestId)).toMatchObject({ previewContext: reference });
  });
  it('gives an explicit snapshot rebind a different request identity', async () => {
    const request = vi.fn(async () => {
      throw new Error('Disconnected');
    });
    const client = createNeoIntakeClient(async () => ({ request }) as unknown as MessageHub);
    const first = draft();
    await expect(client.send(first)).rejects.toThrow('Disconnected');
    const firstId = client.requestIdFor(first);
    const rebound = { ...first, previewContext: { ...reference, snapshot: 'b'.repeat(64) } };
    await expect(client.send(rebound)).rejects.toThrow('Disconnected');
    expect(client.requestIdFor(rebound)).not.toBe(firstId);
    expect(client.requestIdFor(first)).toBe(firstId);
    expect(client.requestIdFor({ ...first, previewContext: undefined })).toBeNull();
  });
  it('does not admit a Preview reference without message content', async () => {
    const getHub = vi.fn();
    const client = createNeoIntakeClient(getHub);
    expect(await client.send({ ...draft(), text: '' })).toHaveProperty('ok', false);
    expect(getHub).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...reference, snapshot: '../report.md' },
    { ...reference, artifactId: '/synthetic/private/report.md' },
    { ...reference, sourcePath: '/synthetic/private/report.md' },
  ])('refuses an invalid draft reference before connecting: %j', async (context) => {
    const getHub = vi.fn();
    const client = createNeoIntakeClient(getHub);
    expect(
      await client.send({ ...draft(), previewContext: context as NeoPreviewReference })
    ).toHaveProperty('ok', false);
    expect(getHub).not.toHaveBeenCalled();
  });
});

describe('persisted Preview reference projection', () => {
  const page = { conversationId, after: 0, limit: 50 };
  function read(context: unknown) {
    return presentConversationAskPage(
      {
        ok: true,
        conversationId,
        nextAfter: 1,
        items: [
          {
            conversationId,
            requestId,
            askOrigin: { sessionId: draft().sessionId, messageId: requestId },
            sequence: 1,
            createdAt: '2026-10-25T09:00:00.000Z',
            content: [{ type: 'text', text: 'Discuss this snapshot.' }],
            previewContext: context,
          },
        ],
      },
      page
    );
  }
  it.each(['available', 'unavailable'] as const)(
    'preserves exact identity and %s state',
    (state) => {
      const context = { ...reference, state };
      expect(read(context)).toMatchObject({ value: { items: [{ previewContext: context }] } });
    }
  );
  it.each([
    null,
    { ...reference, snapshot: 'not-a-hash' },
    { ...reference, state: 'wrong' },
    { ...reference, sourcePath: '/synthetic/private/report.md' },
    { ...reference, displayName: 'x'.repeat(201) },
  ])('refuses an invalid bound page instead of displaying it as unbound: %j', (context) => {
    expect(read(context)).toEqual({ reason: { state: 'unavailable' } });
  });
});
