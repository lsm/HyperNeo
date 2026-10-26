import type { MessageHub } from '@hyperneo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNeoIntakeClient,
  neoDraftPayload,
  NEO_UNCONFIRMED_RECEIPT,
  type NeoPendingAsk,
} from '../neo-intake.ts';

const entry = () => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'neo:root',
  text: 'Original reply',
  images: [{ data: 'aGVsbG8=', media_type: 'image/png' as const }],
  quote: {
    author: 'Neo' as const,
    text: 'Original quote',
    anchor: 'publication-original',
    replyTo: { kind: 'message' as const, id: 'publication-original' },
  },
  previewContext: {
    artifactId: 'report',
    snapshot: 'a'.repeat(64),
    displayName: 'Original report',
    state: 'unavailable' as const,
  },
  createdAt: '2026-10-25T23:00:00.000Z',
  state: 'failed' as const,
  reason: 'Lost receipt',
  thumbnails: [{ index: 1, mediaType: 'image/jpeg' as const, data: 'aGVsbG8=', width: 32 }],
});
const encode = (entries: unknown[]) => JSON.stringify({ version: 1, entries });

function setup() {
  const seen: NeoPendingAsk[][] = [];
  const request = vi.fn(
    async (_method: string, { input }: { input: ReturnType<typeof neoDraftPayload> }) => ({
      ok: true,
      requestId: input.requestId,
      messageId: input.requestId,
      created: false,
      ...(input.previewContext ? { previewContext: entry().previewContext } : {}),
    })
  );
  const getHub = vi.fn(async () => ({ request }) as unknown as MessageHub);
  const client = createNeoIntakeClient(getHub, (asks) => seen.push([...asks]));
  return { client, seen, request, getHub };
}

afterEach(() => vi.unstubAllGlobals());

describe('Neo intake snapshot hydration', () => {
  it('restores without transport and retries the exact original payload and thumbnail', async () => {
    const env = setup();
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    const original = entry();
    expect(env.client.snapshots.restore(encode([original]))).toEqual({ restored: 1 });
    expect(env.getHub).not.toHaveBeenCalled();
    expect(bitmap).not.toHaveBeenCalled();
    const { thumbnails, ...display } = original;
    expect(env.seen.at(-1)?.[0]).toMatchObject(display);
    expect(env.client.requestIdFor(original)).toBe(original.requestId);
    expect(await env.client.retry(original.requestId)).toMatchObject({ ok: true, created: false });
    expect(env.request.mock.calls[0][1].input).toEqual(neoDraftPayload(original, thumbnails));
    expect(bitmap).not.toHaveBeenCalled();
    expect(env.seen.at(-1)?.[0]).toMatchObject({
      createdAt: original.createdAt,
      state: 'accepted',
    });
  });

  it('detaches the private retry from mutable display projections', async () => {
    const env = setup();
    env.client.snapshots.restore(encode([entry()]));
    const shown = env.seen.at(-1)![0];
    shown.text = 'Changed display';
    shown.quote!.replyTo!.id = 'Changed target';
    Object.assign(shown.previewContext!, { snapshot: 'b'.repeat(64) });
    shown.images[0].data = 'Yg==';
    await env.client.retry(entry().requestId);
    expect(env.request.mock.calls[0][1].input).toEqual(
      neoDraftPayload(entry(), entry().thumbnails)
    );
  });

  it('marks interrupted sending unconfirmed without sending automatically', () => {
    const env = setup();
    env.client.snapshots.restore(encode([{ ...entry(), state: 'sending', reason: undefined }]));
    expect(env.seen.at(-1)?.[0]).toMatchObject({
      state: 'failed',
      reason: NEO_UNCONFIRMED_RECEIPT,
    });
    expect(env.getHub).not.toHaveBeenCalled();
  });

  it('keeps accepted entries visible only until authoritative settlement', () => {
    const env = setup();
    env.client.snapshots.restore(encode([{ ...entry(), state: 'accepted', reason: undefined }]));
    expect(env.client.retry(entry().requestId)).toBeNull();
    expect(env.client.requestIdFor(entry())).toBeNull();
    env.client.settle(new Set(['other']));
    expect(env.seen.at(-1)).toHaveLength(1);
    env.client.settle(new Set([entry().requestId]));
    expect(env.seen.at(-1)).toEqual([]);
    expect(env.client.snapshots.restore(encode([entry()]))).toEqual({
      kind: 'intake_not_pristine',
    });
    expect(env.getHub).not.toHaveBeenCalled();
  });

  it('reuses a restored failed identity when sending an equal draft', async () => {
    const env = setup();
    env.client.snapshots.restore(encode([entry()]));
    const { sessionId, text, images, quote, previewContext } = entry();
    await env.client.send({ sessionId, text, images, quote, previewContext });
    expect(env.request.mock.calls[0][1].input.requestId).toBe(entry().requestId);
    expect(env.seen.at(-1)).toHaveLength(1);
  });

  it('restores independent sessions and explicitly discards only the chosen original', async () => {
    const env = setup();
    const second = {
      ...entry(),
      requestId: '00000000-0000-4000-8000-000000000002',
      sessionId: 'neo:other',
    };
    env.client.snapshots.restore(encode([entry(), second]));
    expect(env.client.discard(entry().requestId)).toMatchObject({
      text: entry().text,
      sessionId: entry().sessionId,
    });
    expect(env.client.retry(entry().requestId)).toBeNull();
    await env.client.retry(second.requestId);
    expect(env.request.mock.calls[0][1].input).toMatchObject({
      sessionId: second.sessionId,
      requestId: second.requestId,
    });
    expect(env.seen.at(-1)).toHaveLength(1);
  });

  it.each([undefined, []])(
    'preserves original absent/empty thumbnails without generating new ones: %j',
    async (thumbnails) => {
      const env = setup();
      const bitmap = vi.fn();
      vi.stubGlobal('createImageBitmap', bitmap);
      env.client.snapshots.restore(encode([{ ...entry(), thumbnails }]));
      await env.client.retry(entry().requestId);
      expect(env.request.mock.calls[0][1].input).not.toHaveProperty('thumbnails');
      expect(bitmap).not.toHaveBeenCalled();
    }
  );

  it('preserves legacy absent context without inventing a reference', async () => {
    const env = setup();
    env.client.snapshots.restore(encode([{ ...entry(), previewContext: undefined }]));
    await env.client.retry(entry().requestId);
    expect(env.request.mock.calls[0][1].input).not.toHaveProperty('previewContext');
  });

  it.each([
    '{broken',
    encode([entry(), { ...entry(), requestId: 'invalid' }]),
    encode([entry(), entry()]),
  ])('rejects an invalid entire batch without any partial install', (raw) => {
    const env = setup();
    expect(env.client.snapshots.restore(raw)).toEqual({ kind: 'invalid_snapshot' });
    expect(env.seen).toEqual([]);
    expect(env.client.retry(entry().requestId)).toBeNull();
    expect(env.getHub).not.toHaveBeenCalled();
    expect(env.client.snapshots.restore(encode([entry()]))).toEqual({ restored: 1 });
  });

  it('makes even an empty successful restoration one-shot', () => {
    const env = setup();
    expect(env.client.snapshots.restore(encode([]))).toEqual({ restored: 0 });
    expect(env.client.snapshots.restore(encode([entry()]))).toEqual({
      kind: 'intake_not_pristine',
    });
    expect(env.seen).toEqual([[]]);
  });

  it('does not resurrect a discarded restored request', () => {
    const env = setup();
    env.client.snapshots.restore(encode([entry()]));
    env.client.discard(entry().requestId);
    expect(env.seen.at(-1)).toEqual([]);
    expect(env.client.snapshots.restore(encode([entry()]))).toEqual({
      kind: 'intake_not_pristine',
    });
  });

  it('cannot restore over an in-flight resource or after its settled retirement', async () => {
    const env = setup();
    let finish!: () => void;
    env.getHub.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ request: env.request } as unknown as MessageHub);
        })
    );
    const sent = env.client.send({ sessionId: 'neo:root', text: 'Current draft' });
    expect(env.client.snapshots.restore(encode([entry()]))).toEqual({
      kind: 'intake_not_pristine',
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish();
    const result = await sent;
    if (!result.ok) throw new Error(result.reason);
    env.client.settle(new Set([result.requestId]));
    expect(env.seen.at(-1)).toEqual([]);
    expect(env.client.snapshots.restore(encode([entry()]))).toEqual({
      kind: 'intake_not_pristine',
    });
  });
});
