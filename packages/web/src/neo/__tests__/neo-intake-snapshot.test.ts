import { describe, expect, it, vi } from 'vitest';
import { DRAFT_CHAR_LIMIT } from '@hyperneo/shared';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoIntakeClient, type NeoPendingAsk } from '../neo-intake.ts';
import { attachmentMessage, readNeoAttachment } from '../neo-attachments.ts';
import { publicAskText } from '../NeoPublicConversation.tsx';

const id = '00000000-0000-4000-8000-000000000001';
const codec = () =>
  createNeoIntakeClient(async () => {
    throw new Error('No transport');
  }).snapshots;
const row = () => ({
  requestId: id,
  sessionId: 'neo:10000000-0000-4000-8000-000000000001',
  text: 'Reply to this exact snapshot',
  images: [{ data: 'aGVsbG8=', media_type: 'image/png' }],
  quote: {
    author: 'Neo',
    text: 'Original quote',
    anchor: 'source',
    replyTo: {
      kind: 'message',
      id: 'original-message',
      author: 'neo',
      excerpt: 'Original excerpt',
    },
  },
  previewContext: {
    artifactId: 'original-report',
    snapshot: 'a'.repeat(64),
    displayName: 'Original report',
    state: 'available',
  },
  createdAt: '2026-10-25T20:00:00.000Z',
  state: 'failed',
  reason: 'Receipt unknown',
  thumbnails: [{ index: 1, mediaType: 'image/jpeg', data: 'dGh1bWI=', width: 100, height: 50 }],
});
const raw = (entries: unknown[]) => JSON.stringify({ version: 1, entries });
const refusal = { kind: 'invalid_snapshot' };

describe('Neo intake snapshot contract', () => {
  it.each([
    ['text', 2, 'a'],
    ['text', 6, 'a'],
    ['quote', 2, 'a'],
    ['quote', 6, 'a'],
    ['text', 6, '`'],
  ] as const)(
    'roundtrips composed text attachments in %s with %i files and %j content',
    async (field, count, character) => {
      const files = await Promise.all(
        Array.from({ length: count }, (_, n) =>
          readNeoAttachment(
            new File([character.repeat(128 * 1024)], `notes-${n}.md`, {
              type: 'text/markdown',
            })
          )
        )
      );
      const attachments = files.flatMap((file) => (typeof file === 'string' ? [] : [file]));
      expect(attachments).toHaveLength(count);
      const composed = attachmentMessage('x'.repeat(DRAFT_CHAR_LIMIT), attachments);
      expect(composed.length).toBeGreaterThan(DRAFT_CHAR_LIMIT);
      let shown: readonly NeoPendingAsk[] = [];
      const request = vi.fn(async () => ({ ok: false, reason: 'Synthetic pending receipt' }));
      const intake = createNeoIntakeClient(
        async () => ({ request }) as unknown as MessageHub,
        (asks) => {
          shown = asks;
        }
      );
      await intake.send({
        sessionId: row().sessionId,
        text: field === 'text' ? composed : 'Reply to the attached text',
        ...(field === 'quote'
          ? ({
              quote: {
                author: 'You',
                text: publicAskText(composed),
                anchor: 'source',
                replyTo: { kind: 'message', id: 'original-message' },
              },
            } as const)
          : {}),
      });
      expect(request).toHaveBeenCalledOnce();
      const entries = [row(), ...shown];
      const encoded = intake.snapshots.encode(entries);
      expect(typeof encoded).toBe('string');
      expect(intake.snapshots.decode(encoded)).toEqual({ version: 1, entries });
    }
  );

  it('roundtrips identity, framing, original state/time and prepared thumbnails without transport', () => {
    const getHub = vi.fn(async () => {
      throw new Error('No transport');
    });
    const snapshots = createNeoIntakeClient(getHub).snapshots;
    const original = row();
    const encoded = snapshots.encode([original]);
    expect(typeof encoded).toBe('string');
    expect(snapshots.decode(encoded)).toEqual({ version: 1, entries: [original] });
    expect(getHub).not.toHaveBeenCalled();
  });

  it.each(['sending', 'accepted', 'failed'])(
    'preserves %s instead of silently resending or settling it',
    (state) => {
      const original = { ...row(), state };
      expect(codec().decode(raw([original]))).toEqual({ version: 1, entries: [original] });
    }
  );

  it('preserves explicit empty snapshots and legacy absent context/metadata', () => {
    expect(codec().decode(raw([]))).toEqual({ version: 1, entries: [] });
    const original = {
      requestId: id,
      sessionId: 'neo:legacy',
      text: 'Legacy reply',
      images: [],
      createdAt: row().createdAt,
      state: 'sending',
    };
    expect(codec().decode(codec().encode([original]))).toEqual({ version: 1, entries: [original] });
  });

  it('keeps an unavailable original reference without substituting it', () => {
    const original = row();
    original.previewContext.state = 'unavailable';
    expect(codec().decode(raw([original]))).toEqual({ version: 1, entries: [original] });
  });

  it('preserves order and separate session identities', () => {
    const original = row();
    const other = {
      ...row(),
      requestId: '00000000-0000-4000-8000-000000000002',
      sessionId: 'neo:other',
    };
    expect(codec().decode(raw([original, other]))).toEqual({
      version: 1,
      entries: [original, other],
    });
  });

  it('isolates encoded and decoded values from caller mutations', () => {
    const original = row();
    const encoded = codec().encode([original]);
    original.quote.replyTo.id = 'changed';
    original.images[0].data = 'Y2hhbmdlZA==';
    original.previewContext.snapshot = 'b'.repeat(64);
    original.thumbnails[0].data = 'Y2hhbmdlZA==';
    const decoded = codec().decode(encoded);
    expect(decoded).toEqual({ version: 1, entries: [row()] });
    if ('kind' in decoded) throw new Error('Unexpected refusal');
    decoded.entries[0].quote!.replyTo!.id = 'changed-again';
    expect(codec().decode(encoded)).toEqual({ version: 1, entries: [row()] });
  });

  it.each([
    null,
    undefined,
    '',
    '{',
    '{}',
    '[]',
    'null',
    raw([null]),
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [], sourcePath: '/untrusted' }),
  ])('refuses malformed or future envelopes: %j', (value) => {
    expect(codec().decode(value)).toEqual(refusal);
  });

  it.each([
    { requestId: '' },
    { requestId: 'not-a-uuid' },
    { sessionId: '' },
    { sessionId: 'neo:' },
    { sessionId: 'other:session' },
    { text: 1 },
    { text: '', images: [] },
    { text: '  ', images: [] },
    { images: null },
    { images: [{}] },
    { images: [{ data: 'not base64', media_type: 'image/png' }] },
    { images: [{ data: 'aGVsbG8=', media_type: 'text/plain' }] },
    { images: [{ data: 'aGVsbG8=', media_type: ['image/png'] }] },
    { images: [{ data: 'aGVsbG8=', media_type: 'image/png', path: '/untrusted' }] },
    { images: Array.from({ length: 7 }, () => row().images[0]) },
    { createdAt: '' },
    { createdAt: 'invalid' },
    { createdAt: '2026-02-30T20:00:00.000Z' },
    { state: 'delivered' },
    { state: ['failed'] },
    { state: undefined },
    { reason: 2 },
    { sourcePath: '/untrusted' },
    { previewContext: null },
    { previewContext: { ...row().previewContext, snapshot: 'bad' } },
    { previewContext: { ...row().previewContext, sourcePath: '/untrusted' } },
    { quote: null },
    { quote: { ...row().quote, author: 'Worker' } },
    { quote: { ...row().quote, replyTo: { kind: 'message', id: '' } } },
    { quote: { ...row().quote, replyTo: { kind: 'unknown', id: 'message' } } },
    { quote: { ...row().quote, replyTo: { kind: ['message'], id: 'message' } } },
    { quote: { ...row().quote, replyTo: { ...row().quote.replyTo, path: '/untrusted' } } },
    { thumbnails: null },
    { thumbnails: [{ ...row().thumbnails[0], index: -1 }] },
    { thumbnails: [{ ...row().thumbnails[0], width: 0 }] },
    { thumbnails: [{ ...row().thumbnails[0], height: 100001 }] },
    { thumbnails: [{ ...row().thumbnails[0], data: 'bad' }] },
    { thumbnails: [{ ...row().thumbnails[0], sourcePath: '/untrusted' }] },
    { thumbnails: [row().thumbnails[0], row().thumbnails[0]] },
  ])('refuses a corrupt entry without retaining only its good fields: %j', (change) => {
    expect(codec().decode(raw([{ ...row(), ...change }]))).toEqual(refusal);
    expect(codec().encode([{ ...row(), ...change }])).toEqual(refusal);
  });

  it('refuses an entire mixed batch, including duplicate ids across scopes', () => {
    expect(codec().decode(raw([row(), { ...row(), sessionId: 'neo:other' }]))).toEqual(refusal);
    expect(codec().decode(raw([row(), { ...row(), requestId: 'bad' }]))).toEqual(refusal);
  });

  it('refuses more than twenty entries without pruning', () => {
    const entries = Array.from({ length: 21 }, (_, n) => ({
      ...row(),
      requestId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    }));
    expect(codec().encode(entries)).toEqual(refusal);
    expect(codec().decode(raw(entries))).toEqual(refusal);
  });

  it('preserves an over-capacity live producer until explicit discard frees a slot', async () => {
    let shown: readonly NeoPendingAsk[] = [];
    const request = vi.fn(async () => ({ ok: false, reason: 'Synthetic failed receipt' }));
    const intake = createNeoIntakeClient(
      async () => ({ request }) as unknown as MessageHub,
      (asks) => {
        shown = asks;
      }
    );
    for (let n = 0; n < 21; n += 1) {
      await intake.send({
        sessionId: n % 2 ? 'neo:other' : row().sessionId,
        text: `Failed candidate ${n}`,
      });
      if (n === 19) expect(typeof intake.snapshots.encode(shown)).toBe('string');
    }
    const ids = shown.map((ask) => ask.requestId);
    expect(new Set(ids).size).toBe(21);
    expect(intake.snapshots.encode(shown)).toEqual(refusal);
    expect(shown).toHaveLength(21);
    expect(shown.map((ask) => ask.requestId)).toEqual(ids);
    expect(shown.every((ask) => ask.state === 'failed')).toBe(true);
    expect(request).toHaveBeenCalledTimes(21);
    expect(intake.discard(ids[0])?.text).toBe('Failed candidate 0');
    expect(shown.map((ask) => ask.requestId)).toEqual(ids.slice(1));
    expect(intake.snapshots.decode(intake.snapshots.encode(shown))).toEqual({
      version: 1,
      entries: shown,
    });
    expect(request).toHaveBeenCalledTimes(21);
  });

  it('handles cyclic values and failed serialization as typed refusals', () => {
    const cyclic: Record<string, unknown> = row();
    cyclic.self = cyclic;
    expect(codec().encode([cyclic])).toEqual(refusal);
    expect(
      codec().encode([
        {
          toJSON() {
            throw new Error('No serialization');
          },
        },
      ])
    ).toEqual(refusal);
  });

  it('rejects unknown fields before JSON can silently drop them', () => {
    expect(codec().encode([{ ...row(), sourcePath: undefined }])).toEqual(refusal);
    expect(codec().encode([{ ...row(), callback: () => undefined }])).toEqual(refusal);
  });

  it('refuses inherited serialization that replaces the original pending intent', () => {
    const original = row();
    Object.setPrototypeOf(original, { toJSON: () => ({ ...row(), text: 'Substituted reply' }) });
    expect(codec().encode([original])).toEqual(refusal);
  });

  it('keeps refusal markers immutable between callers', () => {
    const rejected = codec().decode('bad');
    expect(Object.isFrozen(rejected)).toBe(true);
    expect(codec().decode('bad')).toEqual(refusal);
  });

  it('roundtrips a maximum-sized photo and text but refuses larger payloads or total JSON', () => {
    const original = {
      ...row(),
      text: 'x'.repeat(DRAFT_CHAR_LIMIT),
      images: [{ data: 'A'.repeat(8 * 1024 * 1024), media_type: 'image/png' }],
    };
    const encoded = codec().encode([original]);
    expect(typeof encoded).toBe('string');
    expect(codec().decode(encoded)).toEqual({ version: 1, entries: [original] });
    expect(
      codec().encode([
        {
          ...original,
          images: [{ ...original.images[0], data: `${original.images[0].data}AAAA` }],
        },
      ])
    ).toEqual(refusal);
    expect(
      codec().encode([original, { ...original, requestId: '00000000-0000-4000-8000-000000000002' }])
    ).toEqual(refusal);
    expect(codec().decode(' '.repeat(16 * 1024 * 1024 + 1))).toEqual(refusal);
  });

  it.each(['text', 'quote', 'reason'])(
    'allows %s above the composer edit limit within the snapshot budget',
    (field) => {
      const original = row();
      const content = 'x'.repeat(DRAFT_CHAR_LIMIT + 1);
      if (field === 'quote') original.quote.text = content;
      else if (field === 'text') original.text = content;
      else original.reason = content;
      const encoded = codec().encode([original]);
      expect(typeof encoded).toBe('string');
      expect(codec().decode(encoded)).toEqual({ version: 1, entries: [original] });
    }
  );

  it('refuses oversized text and quotes with the same aggregate JSON budget', () => {
    const oversized = 'x'.repeat(16 * 1024 * 1024 + 1);
    for (const original of [
      { ...row(), text: oversized },
      { ...row(), quote: { ...row().quote, text: oversized } },
    ]) {
      expect(codec().encode([original])).toEqual(refusal);
      expect(codec().decode(raw([original]))).toEqual(refusal);
    }
  });
});
