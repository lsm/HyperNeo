// @ts-nocheck
/**
 * Tests for the durable voice-transcript outbox: transcripts staged when the
 * daemon was unreachable during an unmounted voice delivery are parked in
 * localStorage (each entry under its own key) and replayed through
 * session.appendVoiceDraft (with a per-entry dedupId) once the connection is
 * restored. A localStorage failure degrades to the in-session mirror instead
 * of dropping the copy, and a permanent RPC refusal while connected drops the
 * entry rather than retrying it forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hubRequest = vi.fn(async () => ({ success: true }));

vi.mock('../../connection-manager', () => ({
  connectionManager: { getHubIfConnected: vi.fn(() => ({ request: hubRequest })) },
}));

import { connectionManager } from '../../connection-manager.ts';
import { connectionState } from '../../state.ts';
import {
  consumeVoiceTranscriptLanded,
  enqueueTranscript,
  flushPendingTranscripts,
  getAnnouncedEntryIds,
  getDraftBackup,
  getLandingGeneration,
  getLandingTranscript,
  getPendingTranscripts,
  hasClearTombstone,
  isLandingAggregateOrdered,
  isLandingLive,
  markVoiceTranscriptLanded,
  peekExpiredDraftBackup,
  readTabId,
  removeClearTombstone,
  removeDraftBackupKey,
  removePendingTranscript,
  resetVoiceTranscriptOutbox,
  retireDraftBackupClaim,
  saveClearTombstone,
  saveDraftBackup,
  startVoiceTranscriptOutboxFlush,
  stopVoiceTranscriptOutboxFlush,
  voiceTranscriptLandedSignal,
} from '../voice-transcript-outbox.ts';

// happy-dom's localStorage is unreliable across module boundaries — stub the
// global with an in-memory Storage, the established pattern in this repo.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  } as Storage;
}

const originalStorage = globalThis.localStorage;

describe('voice transcript outbox', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
    resetVoiceTranscriptOutbox();
    // mockReset (not clear) so a mockRejectedValueOnce left unconsumed by one
    // test cannot leak into the next as its first hubRequest call.
    hubRequest.mockReset().mockImplementation(async () => ({ success: true }));
    vi.mocked(connectionManager.getHubIfConnected).mockReset().mockReturnValue({
      request: hubRequest,
    });
    connectionState.value = 'disconnected';
  });

  afterEach(() => {
    globalThis.localStorage = originalStorage;
    stopVoiceTranscriptOutboxFlush();
    vi.useRealTimers();
  });

  it('parks a transcript and reads it back', () => {
    enqueueTranscript('s1', 'hello world');
    const entries = getPendingTranscripts();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('s1');
    expect(entries[0].text).toBe('hello world');
    expect(typeof entries[0].id).toBe('string');
  });

  it('prunes to the entry cap (oldest dropped)', () => {
    for (let i = 0; i < 25; i++) enqueueTranscript('s1', `t${i}`);
    const entries = getPendingTranscripts();
    expect(entries.length).toBeLessThanOrEqual(20);
    // The newest survive.
    expect(entries[entries.length - 1].text).toBe('t24');
  });

  it('preserves the entry in the in-session mirror when localStorage rejects writes', () => {
    // Storage disabled / over quota: setItem throws. The mirror must still hold
    // the entry so the user's "saved" toast is true for this session.
    const throwStorage = createMemoryStorage();
    throwStorage.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    globalThis.localStorage = throwStorage;

    enqueueTranscript('s1', 'survives storage failure');
    const entries = getPendingTranscripts();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('survives storage failure');
  });

  it('flushes entries through appendVoiceDraft with a dedupId and removes on ack', async () => {
    enqueueTranscript('s1', 'first');
    enqueueTranscript('s1', 'second');
    await flushPendingTranscripts();

    expect(hubRequest).toHaveBeenCalledTimes(2);
    const calls = hubRequest.mock.calls.map(([m, data]) => data);
    expect(calls.every((d) => d.sessionId === 's1')).toBe(true);
    expect(calls.every((d) => typeof d.dedupId === 'string' && d.dedupId.length > 0)).toBe(true);
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('fires the landed signal after a successful replay', async () => {
    enqueueTranscript('s1', 'landed');
    await flushPendingTranscripts();
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(true);
  });

  it('drops only an entry whose session no longer exists (permanent, no infinite retry)', async () => {
    enqueueTranscript('s1', 'gone');
    hubRequest.mockRejectedValueOnce(new Error('Session not found'));
    await flushPendingTranscripts();
    // A missing session can never recover — dropping avoids retrying forever.
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('retains an entry the daemon refuses for a RETRYABLE reason (full pending draft)', async () => {
    enqueueTranscript('s1', 'blocked');
    hubRequest.mockRejectedValueOnce(new Error('Pending voice draft is at the character limit'));
    await flushPendingTranscripts();
    // The refusal is not permanent — the user can send/clear the draft to make
    // room, so a transcript promised as saved must not be dropped. The follow-up
    // retry timer is cleared by afterEach.
    expect(getPendingTranscripts()).toHaveLength(1);
  });

  it('keeps an entry on an ambiguous Request timeout (append may have committed)', async () => {
    enqueueTranscript('s1', 'ambiguous');
    // The socket dropped after the request was sent — the append may have
    // committed with a lost ack, or never arrived. Retain the entry; the
    // daemon's dedup set makes the eventual retry idempotent either way.
    hubRequest.mockRejectedValueOnce(
      new Error('Request timeout: session.appendVoiceDraft (10000ms)')
    );
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(1);
  });

  it('kicks a flush when enqueuing while already connected', async () => {
    vi.useFakeTimers();
    connectionState.value = 'connected';
    enqueueTranscript('s1', 'fresh');
    expect(getPendingTranscripts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(hubRequest).toHaveBeenCalled();
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('persists a new entry when pruning frees the quota it needs (prune-before-write)', () => {
    // Seed 21 outbox keys directly (over the cap) in a quota-limited store: an
    // outbox-entry setItem throws while at capacity, so the new entry persists
    // only if prune() runs FIRST and removes an over-cap slot.
    const backing = new Map<string, string>();
    for (let i = 0; i < 21; i++) {
      backing.set(
        `hyperneo_voice_transcript_outbox_v1.entry.old-${i}`,
        JSON.stringify({ id: `old-${i}`, sessionId: 's1', text: `t${i}`, createdAt: Date.now() })
      );
    }
    const quotaStorage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k: string) => backing.get(k) ?? null,
      key: (i: number) => [...backing.keys()][i] ?? null,
      removeItem: (k: string) => void backing.delete(k),
      setItem: (k: string, v: string) => {
        if (k.startsWith('hyperneo_voice_transcript_outbox_v1.entry.') && backing.size >= 21) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        backing.set(k, String(v));
      },
    } as Storage;
    globalThis.localStorage = quotaStorage;

    enqueueTranscript('s1', 'newest');
    // The new entry survived in localStorage (a reload would keep it), not
    // just the in-session mirror.
    expect([...backing.values()].some((raw) => raw.includes('newest'))).toBe(true);
  });

  it('does not consume a landing superseded by a newer one', () => {
    markVoiceTranscriptLanded('s1'); // generation N
    const first = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    markVoiceTranscriptLanded('s1'); // generation N+1
    const second = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    expect(second).toBeGreaterThan(first);
    // A refresh that observed the FIRST generation finishing after the second
    // landing must not consume the shared entry — the newer one still needs a
    // refresh.
    consumeVoiceTranscriptLanded('s1', first);
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(true);
    expect(voiceTranscriptLandedSignal.value.get('s1')).toBe(second);
    // The refresh that observed the newer generation consumes it.
    consumeVoiceTranscriptLanded('s1', second);
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(false);
  });

  it('cleans up stale landed markers even when the live queue is under the cap', () => {
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.stale',
      JSON.stringify({ v: 1, ts: Date.now() - 25 * 60 * 60 * 1000, n: 1, text: 'old' })
    );
    enqueueTranscript('s1', 'one'); // under the cap — marker cleanup still runs
    expect(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.stale')
    ).toBeNull();
  });

  it('resumes delivery once a full draft frees up (no hard retry cap)', async () => {
    vi.useFakeTimers();
    enqueueTranscript('s1', 'blocked');
    // First flush: the pending draft is full → the entry is retained and a
    // follow-up retry is scheduled.
    hubRequest.mockRejectedValueOnce(new Error('Pending voice draft is at the character limit'));
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(1);
    // The user sends/clears the draft → room appears → the steady backoff
    // retry keeps checking and now succeeds, with no cap that permanently
    // stops delivery.
    hubRequest.mockResolvedValue({ success: true });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('prunes expired keys even when the live set is under the cap', () => {
    // Seed a stale entry directly (createdAt beyond the TTL) so allEntries()
    // hides it from reads — but prune() must still remove the key from storage,
    // or expired entries would accumulate unboundedly.
    const stale = {
      id: 'stale-1',
      sessionId: 's1',
      text: 'old',
      createdAt: Date.now() - 25 * 60 * 60 * 1000,
    };
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.stale-1',
      JSON.stringify(stale)
    );
    enqueueTranscript('s1', 'fresh');
    expect(getPendingTranscripts().map((e) => e.text)).toEqual(['fresh']);
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.stale-1')).toBeNull();
  });

  it('keeps entries for retry when the socket drops mid-flush', async () => {
    enqueueTranscript('s1', 'a');
    enqueueTranscript('s1', 'b');
    // The second append's RPC drops (socket goes down) after the first landed.
    hubRequest.mockImplementationOnce(async () => ({ success: true }));
    hubRequest.mockRejectedValueOnce(new Error('socket closed'));
    vi.mocked(connectionManager.getHubIfConnected)
      .mockReturnValueOnce({ request: hubRequest }) // flush start
      .mockReturnValueOnce({ request: hubRequest }) // loop check for 'a'
      .mockReturnValueOnce({ request: hubRequest }) // loop check for 'b'
      .mockReturnValue(null); // connection dropped after the RPC failed
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(1);
    expect(getPendingTranscripts()[0].text).toBe('b');
  });

  it('defers later entries for a session after an older one is retained (per-session FIFO)', async () => {
    enqueueTranscript('s1', 'older');
    enqueueTranscript('s1', 'newer');
    enqueueTranscript('s2', 'other');
    // The older s1 entry is retained (draft too full); the NEWER s1 entry must
    // not be appended ahead of it, while s2 still proceeds.
    hubRequest.mockRejectedValueOnce(new Error('Pending voice draft is at the character limit'));
    await flushPendingTranscripts();
    const sessions = hubRequest.mock.calls.map(([m, d]) => d?.sessionId);
    expect(sessions.filter((s) => s === 's2')).toHaveLength(1);
    expect(sessions.filter((s) => s === 's1')).toHaveLength(1); // only the older s1 was attempted
    expect(getPendingTranscripts().map((e) => e.text)).toEqual(['older', 'newer']);
  });

  it('keeps the shared landed marker when a tab consumes its landing', () => {
    markVoiceTranscriptLanded('s1');
    consumeVoiceTranscriptLanded('s1', voiceTranscriptLandedSignal.value.get('s1') ?? 0);
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(false);
    // Consumption is local to this tab — the marker stays so a LATER tab can
    // hydrate it (TTL prunes it).
    expect(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1')
    ).not.toBeNull();
    // The retained marker must NOT read as live in the CONSUMING tab — or the
    // save-suppression it lifted would re-engage and disable server-side draft
    // durability until the marker's TTL expires.
    expect(isLandingLive('s1')).toBe(false);
  });

  it('treats a NEWER marker as live again after an earlier one was consumed', () => {
    markVoiceTranscriptLanded('s1');
    consumeVoiceTranscriptLanded('s1', voiceTranscriptLandedSignal.value.get('s1') ?? 0);
    expect(isLandingLive('s1')).toBe(false);
    // A second landing (same tab here; another tab in production rewrites the
    // marker with a fresh counter) is a NEW landing — live again.
    markVoiceTranscriptLanded('s1');
    expect(isLandingLive('s1')).toBe(true);
  });

  it('retires the backup for the consumed landing generation, not a newer one', () => {
    // Backups live under TAB-OWNED keys — locate this tab's through the API.
    const claimOf = () => peekExpiredDraftBackup('s1');
    // A NEWER-generation backup survives a stale (mismatched-generation) consume.
    markVoiceTranscriptLanded('s1'); // generation N
    markVoiceTranscriptLanded('s1'); // generation N+1
    const newestGen = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    saveDraftBackup('s1', 'newer edit', newestGen);
    const newerClaim = claimOf();
    expect(newerClaim?.content).toBe('newer edit');
    consumeVoiceTranscriptLanded('s1', (newestGen ?? 2) - 1);
    expect(claimOf()?.content).toBe('newer edit');
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(true);

    // The matching-generation backup is retired on reconcile — a reload must
    // show the freshly-merged transcript, not text the user sent/cleared.
    saveDraftBackup('s1', 'gen2 edit', newestGen);
    consumeVoiceTranscriptLanded('s1', newestGen);
    expect(claimOf()).toBeNull();
  });

  it("does not retire ANOTHER tab's backup when consuming a landing", () => {
    // Two tabs defer edits for the same landing; this (idle) tab consumes the
    // shared generation. Consumption is LOCAL — it must retire only this
    // tab's backup key, or the editing tab's only durable copy is deleted
    // while it still suppresses server saves (a reload before its next edit
    // would then lose the post-landing text permanently).
    markVoiceTranscriptLanded('s1', 'voice', 'e1');
    const generation = voiceTranscriptLandedSignal.value.get('s1') ?? 1;
    // The OTHER tab's backup under its own tab-owned key.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.foreign-tab',
      JSON.stringify({ content: 'other tab edits', ts: Date.now(), generation })
    );
    saveDraftBackup('s1', 'my edits', generation);
    consumeVoiceTranscriptLanded('s1', generation);
    expect(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.draft.s1.foreign-tab')
    ).not.toBeNull();
    // This tab's own backup was retired by its own consumption.
    expect(peekExpiredDraftBackup('s1')?.content).toBe('other tab edits');
  });

  it('does not restore a draft backup whose landing has expired', () => {
    saveDraftBackup('s1', 'stale edits', 1);
    // No live landing (signal empty, marker absent) — restoring the backup
    // would let the normal save overwrite the freshly-merged transcript.
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(false);
    expect(getDraftBackup('s1')).toBeNull();
  });

  it('treats a landing as live only while a fresh marker exists', () => {
    markVoiceTranscriptLanded('s1');
    expect(isLandingLive('s1')).toBe(true);
  });

  it('treats a landing as dead when only an expired marker remains', () => {
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now() - 25 * 60 * 60 * 1000, n: 1, text: 'old' })
    );
    expect(isLandingLive('s1')).toBe(false);
  });

  it('prunes expired draft backups proactively', () => {
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1',
      JSON.stringify({ content: 'stale', ts: Date.now() - 25 * 60 * 60 * 1000 })
    );
    enqueueTranscript('s1', 'fresh'); // triggers prune, which scans backups too
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.draft.s1')).toBeNull();
  });

  it('clears a local landing when another tab prunes its marker', () => {
    markVoiceTranscriptLanded('s1');
    startVoiceTranscriptOutboxFlush();
    // Another tab pruned the marker (removing the shared key) — this tab must
    // clear its local landing so the save-suppression lifts.
    localStorage.removeItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1');
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
        newValue: null,
      })
    );
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(false);
    stopVoiceTranscriptOutboxFlush();
  });

  it('writes distinct landed-marker values for repeated landings (cross-tab storage events)', () => {
    markVoiceTranscriptLanded('s1');
    const first = localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1');
    markVoiceTranscriptLanded('s1');
    const second = localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1');
    // A same-value write would not emit a storage event in other tabs, which
    // would then never learn of the second landing.
    expect(first).not.toBe(second);
    // The marker is JSON carrying the landing's timestamp, monotonic counter,
    // and the transcript text (needed by backup reconciliation). The counter
    // is module-global, so assert the RELATIVE bump rather than absolute n.
    const firstParsed = JSON.parse(first ?? '{}') as { ts?: number; n?: number };
    const secondParsed = JSON.parse(second ?? '{}') as { ts?: number; n?: number };
    // The generation carries a per-tab offset (concurrent-landing collision
    // resistance), so same-tab repeats bump by MORE than one — assert
    // monotonicity rather than an exact step.
    expect(secondParsed.n).toBeGreaterThan(firstParsed.n ?? 0);
    expect(typeof firstParsed.ts).toBe('number');
  });

  it('carries the transcript text in the landed marker for reconciliation', () => {
    markVoiceTranscriptLanded('s1', 'the transcript');
    // The consuming/reloading tab learns WHICH part of the merged server draft
    // is the transcript.
    expect(getLandingTranscript('s1')).toBe('the transcript');
    consumeVoiceTranscriptLanded('s1', 1);
    // The marker survives consumption; its text stays recoverable for the
    // reconcile paths that run after the landing is settled (cross-tab text
    // recovery from the marker alone is covered by the hydration test).
    expect(getLandingTranscript('s1')).toBe('the transcript');
  });

  it('aggregates the texts of a live landing sequence (multiple queued entries)', () => {
    // Two outbox entries for one session land while the refresh is deferred —
    // the daemon accumulates BOTH into inputDraftVoicePending, so the
    // reconciliation text must be the aggregate, not just the latest entry's.
    markVoiceTranscriptLanded('s1', 'first');
    markVoiceTranscriptLanded('s1', 'second');
    expect(getLandingTranscript('s1')).toBe('first second');
    const marker = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1') ?? '{}'
    ) as { text?: string };
    expect(marker.text).toBe('first second');

    // Consumption implies a full merge cleared the server-side pending — the
    // next landing sequence starts a fresh aggregate.
    const secondGen = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    consumeVoiceTranscriptLanded('s1', secondGen);
    markVoiceTranscriptLanded('s1', 'third');
    expect(getLandingTranscript('s1')).toBe('third');
  });

  it('lets a cross-tab marker REPLACE the local aggregate (authoritative)', () => {
    markVoiceTranscriptLanded('s1', 'local sequence');
    startVoiceTranscriptOutboxFlush();
    // Another tab (which already consumed the earlier landing) lands a fresh
    // transcript — its marker aggregate supersedes this tab's stale local one.
    // The write precedes the event, as a real cross-tab delivery does.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now(), n: 9, text: 'authoritative' })
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
        newValue: localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1'),
      })
    );
    expect(getLandingTranscript('s1')).toBe('authoritative');
    stopVoiceTranscriptOutboxFlush();
  });

  it('removes ADJACENT expired markers and backups without skipping keys', () => {
    // Removing while iterating localStorage by index shifts later keys into
    // the current index — the old loop skipped a stale key that followed a
    // removed one. Seed adjacent stale keys to prove collect-then-remove.
    const expired = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.a',
      JSON.stringify({ v: 1, ts: expired, n: 1, text: 'x' })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.b',
      JSON.stringify({ v: 1, ts: expired, n: 2, text: 'y' })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.a',
      JSON.stringify({ content: 'old-a', ts: expired, generation: 1 })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.b',
      JSON.stringify({ content: 'old-b', ts: expired, generation: 1 })
    );
    enqueueTranscript('s1', 'fresh'); // triggers prune
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.a')).toBeNull();
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.b')).toBeNull();
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.draft.a')).toBeNull();
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.draft.b')).toBeNull();
  });

  it('hydrates existing landed markers into the signal at startup', () => {
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s9',
      JSON.stringify({ v: 1, ts: Date.now(), n: 1, text: 'hello' })
    );
    startVoiceTranscriptOutboxFlush();
    expect(voiceTranscriptLandedSignal.value.has('s9')).toBe(true);
    expect(getLandingTranscript('s9')).toBe('hello');
    stopVoiceTranscriptOutboxFlush();
  });

  it('rehydrates the GENERATION from the marker so backup retirement survives reloads', () => {
    // A previous page life saw TWO landings (generation 2) and saved a
    // generation-2 draft backup under ITS tab-owned key. The reload hydrates
    // the single retained marker — the generation must come from the marker's
    // counter, or the consumption would clear with a restarted counter and
    // orphan the backup. (The previous tab is gone, so its key is seeded
    // directly and claimed by key through the peek API.)
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now(), n: 2, text: 'agg' })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.dead-tab',
      JSON.stringify({ content: 'edits', ts: Date.now(), generation: 2 })
    );
    startVoiceTranscriptOutboxFlush();
    expect(voiceTranscriptLandedSignal.value.get('s1')).toBe(2);
    // A reload folds the claimed backup into the composer and retires it by
    // its exact key (clearDraftBackup is own-tab scoped and cannot reach a
    // dead tab's key).
    const claim = peekExpiredDraftBackup('s1');
    expect(claim?.content).toBe('edits');
    removeDraftBackupKey(claim?.key ?? '', 2);
    expect(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.draft.s1.dead-tab')
    ).toBeNull();
    stopVoiceTranscriptOutboxFlush();
  });

  it('keeps a full live queue intact at startup (no slot reservation without an enqueue)', () => {
    // Exactly MAX live entries (all fresh): startup must NOT enforce the
    // pre-enqueue slot reservation — that assumes a write follows, and here it
    // would permanently drop the oldest still-deliverable transcript.
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      sessionId: 's1',
      text: `t${i}`,
      createdAt: Date.now() - i,
    }));
    for (const entry of entries) {
      localStorage.setItem(
        `hyperneo_voice_transcript_outbox_v1.entry.${entry.id}`,
        JSON.stringify(entry)
      );
    }
    startVoiceTranscriptOutboxFlush();
    for (const entry of entries) {
      expect(
        localStorage.getItem(`hyperneo_voice_transcript_outbox_v1.entry.${entry.id}`)
      ).not.toBeNull();
    }
    stopVoiceTranscriptOutboxFlush();
  });

  it('removes an entry that the daemon reports as already merged (deduped ack)', async () => {
    enqueueTranscript('s1', 'already landed');
    hubRequest.mockResolvedValueOnce({ success: true, deduped: true });
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(0);
    // No prior landing announced this transcript — the deduped ack is the
    // only signal it merged, so the landing IS announced here.
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(true);
  });

  it('does not announce a SECOND landing for an already-announced deduped entry', async () => {
    // Another tab's append committed this transcript and its landing was
    // refreshed and CONSUMED there; the retained marker still names the entry
    // id. This tab's concurrent flush gets a deduped ack — announcing another
    // landing would be false (no pending is staged) and could let a later
    // clear-reconcile resurrect the already-merged transcript.
    enqueueTranscript('s1', 'shared', 'entry-shared');
    markVoiceTranscriptLanded('s1', 'shared', 'entry-shared');
    consumeVoiceTranscriptLanded('s1', voiceTranscriptLandedSignal.value.get('s1') ?? 1);
    expect(getAnnouncedEntryIds('s1')).toContain('entry-shared'); // retained marker names it
    hubRequest.mockResolvedValueOnce({ success: true, deduped: true });
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(0);
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(false);
  });

  it('announces a deduped entry whose id was never announced, even on a phrase collision', async () => {
    // An older consumed landing's marker contains the same PHRASE as a NEWER
    // transcript. The newer entry's append committed but lost its ack, so its
    // replay returns deduped — but its id was never announced. Matching by
    // TEXT here would mistake the old marker for an announcement and skip the
    // landing, leaving the newly staged transcript invisible to a mounted
    // composer until the next navigation. Identity is matched by ENTRY ID.
    markVoiceTranscriptLanded('s1', 'note the weather', 'entry-old');
    consumeVoiceTranscriptLanded('s1', voiceTranscriptLandedSignal.value.get('s1') ?? 1);
    enqueueTranscript('s1', 'note the weather', 'entry-new');
    hubRequest.mockResolvedValueOnce({ success: true, deduped: true });
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(0);
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(true);
  });

  it('cleans an entry whose TTL expires in a long-lived tab on the next flush', async () => {
    enqueueTranscript('s1', 'ages out');
    // The entry expires (24h pass) while the tab stays open: reads filter it,
    // and without this flush-path cleanup its key would linger forever (the
    // startup prune never re-runs).
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    expect(getPendingTranscripts()).toHaveLength(0);
    await flushPendingTranscripts();
    expect(getPendingTranscripts()).toHaveLength(0);
    const keys = Object.keys(localStorage) as string[];
    expect(keys.some((k) => k.startsWith('hyperneo_voice_transcript_outbox_v1.entry.'))).toBe(
      false
    );
  });

  it('does nothing when the connection is down', async () => {
    enqueueTranscript('s1', 'waiting');
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(null);
    await flushPendingTranscripts();
    expect(hubRequest).not.toHaveBeenCalled();
    expect(getPendingTranscripts()).toHaveLength(1);
  });

  it('auto-flushes when the connection (re)establishes', async () => {
    vi.useFakeTimers();
    enqueueTranscript('s1', 'queued while down');
    startVoiceTranscriptOutboxFlush();
    connectionState.value = 'connected';
    await vi.advanceTimersByTimeAsync(600);
    expect(hubRequest).toHaveBeenCalled();
    expect(getPendingTranscripts()).toHaveLength(0);
  });

  it('flushes an entry another tab wrote to shared storage (storage event)', async () => {
    vi.useFakeTimers();
    // Another tab wrote the entry to the shared localStorage, then the storage
    // event fired here — this connected tab must flush it rather than wait for
    // an unrelated reconnect.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.other',
      JSON.stringify({ id: 'other', sessionId: 's2', text: 'hi', createdAt: Date.now() })
    );
    startVoiceTranscriptOutboxFlush();
    connectionState.value = 'connected';
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'hyperneo_voice_transcript_outbox_v1.entry.other' })
    );
    await vi.advanceTimersByTimeAsync(600);
    expect(hubRequest).toHaveBeenCalledWith(
      'session.appendVoiceDraft',
      expect.objectContaining({ sessionId: 's2', text: 'hi' })
    );
    stopVoiceTranscriptOutboxFlush();
  });

  it('drops the local mirror when another tab removes a shared entry key', () => {
    // Tab A enqueues (mirror + shared key); connected tab B flushes the shared
    // entry and removes its key. A's mirror must follow the removal, or
    // allEntries() (mirror wins on conflict) resurrects the entry here and
    // replays an already-delivered id as a FALSE landing that suppresses
    // draft saves.
    enqueueTranscript('s1', 'shared text');
    expect(getPendingTranscripts()).toHaveLength(1);
    const [entry] = getPendingTranscripts();
    localStorage.removeItem(`hyperneo_voice_transcript_outbox_v1.entry.${entry.id}`);
    startVoiceTranscriptOutboxFlush();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `hyperneo_voice_transcript_outbox_v1.entry.${entry.id}`,
        newValue: null,
      })
    );
    expect(getPendingTranscripts()).toHaveLength(0);
    stopVoiceTranscriptOutboxFlush();
  });

  it('adds a landing to the signal when another tab writes a landed marker', () => {
    startVoiceTranscriptOutboxFlush();
    // A REAL cross-tab event follows the writing tab's setItem — the handler
    // revalidates the event against the stored value, so the test writes too.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s3',
      JSON.stringify({ v: 1, ts: Date.now(), n: 1, text: 'cross-tab' })
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s3',
        newValue: localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s3'),
      })
    );
    expect(voiceTranscriptLandedSignal.value.has('s3')).toBe(true);
    expect(getLandingTranscript('s3')).toBe('cross-tab');
    stopVoiceTranscriptOutboxFlush();
  });

  it('does not re-write the landed marker when handling a cross-tab storage event', () => {
    // A storage event for a landed marker must update only the local signal —
    // re-persisting the marker would fire another event in the writer and loop.
    const raw = JSON.stringify({ v: 1, ts: Date.now(), n: 1, text: 'x' });
    localStorage.setItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s4', raw);
    startVoiceTranscriptOutboxFlush();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s4',
        newValue: raw,
      })
    );
    expect(voiceTranscriptLandedSignal.value.has('s4')).toBe(true);
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s4')).toBe(raw);
    stopVoiceTranscriptOutboxFlush();
  });

  it('prunes expired entries at startup even if nothing is ever enqueued again', () => {
    // The app reopens >24h after transcripts were queued: reads filter the
    // entries out, but without a startup prune their keys would linger forever
    // (prune otherwise runs only before an enqueue write).
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.stale',
      JSON.stringify({
        id: 'stale',
        sessionId: 's1',
        text: 'old',
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
      })
    );
    startVoiceTranscriptOutboxFlush();
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.stale')).toBeNull();
    stopVoiceTranscriptOutboxFlush();
  });

  it("keeps ANOTHER tab's owed-clear tombstone when consuming a landing", () => {
    // Tab B owes a clear (persisted under ITS tab-owned tombstone key) while
    // this tab refreshes and consumes the shared landing — the consumption is
    // local and retires only THIS tab's tombstone (consumeLanding calls
    // removeClearTombstone), never tab B's clear intent, or tab B's retained
    // backup could resurrect text its user already sent.
    markVoiceTranscriptLanded('s1', 'voice', 'e1');
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.clear.s1.foreign-tab',
      JSON.stringify({ ts: Date.now() })
    );
    saveClearTombstone('s1');
    consumeVoiceTranscriptLanded('s1', voiceTranscriptLandedSignal.value.get('s1') ?? 1);
    removeClearTombstone('s1'); // what consumeLanding does on landing settlement
    expect(hasClearTombstone('s1')).toBe(false); // own tombstone retired
    expect(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.clear.s1.foreign-tab')
    ).not.toBeNull();
  });

  it('marks same-generation siblings superseded without deleting them', () => {
    markVoiceTranscriptLanded('s1', 'voice', 'e1'); // generation 1
    // Two tabs deferred edits for the same landing; ours (the freshest at
    // claim time) is committed durably. The OLDER sibling's edits are
    // superseded — a later reload must not restore them — but its KEY is
    // another still-active tab's only durable copy: deleting it would lose
    // that tab's draft on a crash. It is skipped on read, not removed.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.older-tab',
      JSON.stringify({ content: 'older edits', ts: Date.now() - 1000, generation: 1 })
    );
    saveDraftBackup('s1', 'newer edits', 1);
    const claim = peekExpiredDraftBackup('s1');
    expect(claim?.content).toBe('newer edits');
    // A NEWER landing's backup and a same-generation write made AFTER the
    // committed claim are both live state, never superseded.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.future-tab',
      JSON.stringify({ content: 'gen 2 edits', ts: Date.now(), generation: 2 })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.active-tab',
      JSON.stringify({ content: 'live edits', ts: Date.now() + 5000, generation: 1 })
    );
    retireDraftBackupClaim(claim ?? { key: '', generation: 1, ts: 0 });
    // The older sibling still EXISTS (its tab may still need it) but is no
    // longer restorable; the live and newer-generation ones remain claims.
    expect(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.draft.s1.older-tab')
    ).not.toBeNull();
    const next = peekExpiredDraftBackup('s1');
    expect(next?.content).toBe('live edits');
  });

  it('keeps the supersede marker monotonic across racing acknowledgements', () => {
    // A newer generation's merge acknowledges FIRST; an older claim's late
    // acknowledgement writes its OWN record key (content-derived, so it can
    // never overwrite a stronger record) and the effective boundary stays the
    // maximum — a sibling the generation-2 record ruled out must remain
    // unrestorable.
    const suppressedTs = Date.now() - 10_000;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1.2.1000',
      JSON.stringify({ generation: 2, beforeTs: suppressedTs })
    );
    const lateOlderClaim = {
      key: 'hyperneo_voice_transcript_outbox_v1.draft.s1.late-tab',
      generation: 1,
      ts: Date.now(),
    };
    localStorage.setItem(
      lateOlderClaim.key,
      JSON.stringify({ content: 'older edits', ts: lateOlderClaim.ts, generation: 1 })
    );
    retireDraftBackupClaim(lateOlderClaim);
    // The weaker record exists under its own key but never un-supersedes: a
    // generation-2 backup written before the strong record's boundary stays
    // unrestorable.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.ruled-out',
      JSON.stringify({ content: 'stale sibling edits', ts: suppressedTs - 1, generation: 2 })
    );
    expect(peekExpiredDraftBackup('s1')?.content).not.toBe('stale sibling edits');
    // A same-generation LATER claim still advances the effective boundary:
    // a backup written after it becomes unrestorable too.
    const newerBoundary = Date.now() + 60_000;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1.2.2000',
      JSON.stringify({ generation: 2, beforeTs: newerBoundary })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.late-sibling',
      JSON.stringify({ content: 'later sibling edits', ts: newerBoundary - 1, generation: 2 })
    );
    expect(peekExpiredDraftBackup('s1')?.content).not.toBe('later sibling edits');
  });

  it('clears the supersede record when a landing epoch restarts', () => {
    // The previous sequence's marker EXPIRED (pruned) before its supersede
    // record did. The next landing restarts the generation counter at 1 — the
    // stale generation-5 record would then suppress EVERY backup of the new
    // epoch (their generations compare lower), making them unrestorable while
    // the landing suppresses the owner's server saves.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1',
      JSON.stringify({ generation: 5, beforeTs: Date.now() })
    );
    // No retained marker — a fresh epoch begins (its generation is
    // clock-scaled, but the epoch RESET is what matters).
    markVoiceTranscriptLanded('s1', 'new voice', 'e1');
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(true);
    expect(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.superseded.s1')).toBeNull();
    // A backup of the new epoch's landing is restorable.
    saveDraftBackup('s1', 'fresh edits', voiceTranscriptLandedSignal.value.get('s1') ?? 1);
    expect(peekExpiredDraftBackup('s1')?.content).toBe('fresh edits');
  });

  it('exposes EVERY live entry when concurrent enqueues exceed the cap', () => {
    // Two tabs' pre-write prunes cannot see each other's writes, so more
    // than 20 live keys can exist. The flush selection must return ALL of
    // them OLDEST-first: capping the batch would let one blocked session's
    // 20 oldest entries hide another session's deliverable entry (#21) —
    // global head-of-line blocking for up to the 24h TTL.
    for (let i = 0; i < 25; i++) {
      localStorage.setItem(
        `hyperneo_voice_transcript_outbox_v1.entry.over-${i}`,
        JSON.stringify({
          id: `over-${i}`,
          sessionId: i === 24 ? 's2' : 's1',
          text: `t${i}`,
          createdAt: Date.now() + i,
        })
      );
    }
    const pending = getPendingTranscripts();
    expect(pending).toHaveLength(25);
    expect(pending[0].text).toBe('t0'); // oldest-first
    expect(pending[24].text).toBe('t24'); // the other session's entry is exposed too
  });

  it('drops this tab’s own local landing state when its expired marker is pruned', () => {
    markVoiceTranscriptLanded('s1', 'old voice', 'e1');
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(true);
    vi.useFakeTimers();
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    enqueueTranscript('s1', 'fresh'); // triggers pruneExpired, which prunes the marker
    // localStorage removals emit no storage event in the WRITING tab — the
    // prune itself must drop the local landing, or a later landing for this
    // session would republish "old + new" and re-announce the merged old
    // transcript into reconciliations.
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(false);
    expect(getLandingTranscript('s1')).toBeNull();
  });

  it('mints a fresh tab id when the stored id has a live heartbeat (cloned tab)', () => {
    // Duplicating a tab copies sessionStorage, so the clone would inherit the
    // source's tab id and "tab-owned" keys would collide. A fresh heartbeat
    // at startup means the id's owner is still running — this context is a
    // clone and must mint its own id.
    sessionStorage.setItem('hyperneo_tab_id', 'source-tab-id');
    localStorage.setItem('hyperneo_tab_heartbeat.source-tab-id', String(Date.now()));
    const cloneId = readTabId();
    expect(cloneId).not.toBe('source-tab-id');
    // The clone's id is persisted for ITS reloads.
    expect(sessionStorage.getItem('hyperneo_tab_id')).not.toBe('source-tab-id');
  });

  it('unions the persisted aggregate when rewriting the marker (unseen cross-tab landing)', () => {
    // Another tab landed 'first' but this tab has not processed its storage
    // event. This tab's own landing must not REPLACE the marker's earlier
    // transcript/ids — reconciliation that falls back to the marker would
    // otherwise lose the earlier voice input.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now(), n: 3, text: 'first', ids: ['e1'] })
    );
    markVoiceTranscriptLanded('s1', 'second', 'e2');
    const marker = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1') ?? '{}'
    );
    expect(marker.text).toContain('first');
    expect(marker.text).toContain('second');
    expect(marker.ids).toContain('e1');
    expect(marker.ids).toContain('e2');
    expect(getAnnouncedEntryIds('s1')).toContain('e1');
  });

  it('unions by ENTRY identity, not substring (distinct occurrence preserved)', () => {
    // Tab A landed 'hello' (e1); tab B lands 'hello world' (e2) before
    // processing A's storage event. B's aggregate CONTAINS A's phrase, but
    // the entries are distinct — A's dictated occurrence must survive in the
    // rewritten marker even though a substring check would call it included.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now(), n: 3, text: 'hello', ids: ['e1'] })
    );
    markVoiceTranscriptLanded('s1', 'hello world', 'e2');
    expect(getLandingTranscript('s1')).toContain('hello world hello');
    expect(getAnnouncedEntryIds('s1')).toContain('e1');
    expect(getAnnouncedEntryIds('s1')).toContain('e2');
  });

  it('reads the landing generation from the marker before the signal hydrates', () => {
    // This tab has not processed the marker's storage event, so the
    // process-local signal is empty — a backup saved in that window must
    // still carry the marker's generation (0 would orphan it: a later
    // generation-matched consumption could never retire it).
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now(), n: 7, text: 'agg', ids: [] })
    );
    expect(voiceTranscriptLandedSignal.value.has('s1')).toBe(false);
    expect(getLandingGeneration('s1')).toBe(7);
  });

  it('removePendingTranscript drops a single entry', () => {
    enqueueTranscript('s1', 'a');
    enqueueTranscript('s1', 'b');
    const [first] = getPendingTranscripts();
    removePendingTranscript(first.id);
    const rest = getPendingTranscripts();
    expect(rest).toHaveLength(1);
    expect(rest[0].text).toBe('b');
  });
});

describe('voice transcript outbox — review-hardening round', () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryStorage();
    vi.useFakeTimers();
    resetVoiceTranscriptOutbox();
  });
  afterEach(() => {
    globalThis.localStorage = originalStorage;
    vi.useRealTimers();
  });

  it('prefers the persisted marker generation when it is newer than the stale local one', () => {
    // Another tab wrote a NEWER generation while this tab's storage event is
    // still in flight: a backup tagged with the stale LOCAL generation would
    // escape the newer landing's generation-matched retirement.
    markVoiceTranscriptLanded('s1', 'local voice');
    const local = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    const newer = local + 500;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now(), n: newer, text: 'agg', ids: [] })
    );
    expect(getLandingGeneration('s1')).toBe(newer);
    // Hydrate the marker (as a reload would) so this tab can consume it — a
    // CONSUMED marker never revives a generation afterwards.
    startVoiceTranscriptOutboxFlush();
    expect(voiceTranscriptLandedSignal.value.get('s1')).toBe(newer);
    consumeVoiceTranscriptLanded('s1', newer);
    expect(getLandingGeneration('s1')).toBeUndefined();
    stopVoiceTranscriptOutboxFlush();
  });

  it('expires a hydrated landing on the MARKER timestamp, not the hydration time', () => {
    // A marker written 23h ago is hydrated near its expiry: the local landing
    // must die with the marker 1h later, not live a fresh 24h from hydration.
    vi.useRealTimers();
    const staleTs = Date.now() - 23 * 60 * 60 * 1000;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: staleTs, n: 3, text: 'agg', ids: [] })
    );
    startVoiceTranscriptOutboxFlush(); // hydrates the marker into the signal
    expect(isLandingLive('s1')).toBe(true);
    vi.useFakeTimers();
    vi.setSystemTime(staleTs + 25 * 60 * 60 * 1000); // 25h after the marker
    expect(isLandingLive('s1')).toBe(false);
    stopVoiceTranscriptOutboxFlush();
  });

  it('raises the persisted generation from a revalidated marker before writing', () => {
    // A competing tab published a HIGHER generation (clock-scaled counters put
    // it above this tab's computed seq) between the initial marker read and the
    // compare-and-revalidate read: the write must not regress the persisted
    // counter below the competing generation + 1.
    vi.useRealTimers();
    const now = Date.now();
    const baseMarker = JSON.stringify({
      v: 1,
      ts: now - 1000,
      n: now - 60_000,
      text: null,
      ids: [],
    });
    const higherMarker = JSON.stringify({
      v: 1,
      ts: now,
      n: now + 100_000,
      text: 'other tab',
      ids: ['e-other'],
    });
    localStorage.setItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1', baseMarker);
    const realGetItem = localStorage.getItem.bind(localStorage);
    let reads = 0;
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      if (key === 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1') {
        reads += 1;
        // read #1: markVoiceTranscriptLanded's initial read (base marker);
        // read #2: the CAS loop's revalidation read observes the competing
        // tab's higher marker.
        if (reads === 2) return higherMarker;
      }
      return realGetItem(key);
    });
    markVoiceTranscriptLanded('s1', 'my voice', 'e-mine');
    spy.mockRestore();
    const written = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1')
    );
    expect(written.n).toBeGreaterThanOrEqual(now + 100_001);
  });

  it('writes the landed marker exactly once when no tab contends', () => {
    vi.useRealTimers();
    const setSpy = vi.spyOn(localStorage, 'setItem');
    markVoiceTranscriptLanded('s1', 'solo voice', 'e-solo');
    const markerWrites = setSpy.mock.calls.filter(
      ([key]) => key === 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1'
    );
    expect(markerWrites).toHaveLength(1);
    setSpy.mockRestore();
  });

  it('unions persisted entries BEFORE the local entry (daemon append order)', () => {
    vi.useRealTimers();
    // The persisted marker's entry committed first; the local entry landed
    // after — the aggregate must read persisted-then-local, or a fallback
    // reconciliation restores the dictated order backwards.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: 40,
        text: null,
        ids: ['e-first'],
        entries: [{ id: 'e-first', text: 'first words' }],
      })
    );
    // Seed a live local landing for the same session whose id the marker
    // lacks, then rewrite through the CAS union path.
    markVoiceTranscriptLanded('s1', 'second words', 'e-second');
    expect(getLandingTranscript('s1')).toBe('first words second words');
  });

  it('never lists an announced entry id twice in the marker', () => {
    vi.useRealTimers();
    // The same entry id is recorded twice in one landing sequence (the
    // per-entry record and the explicit id insertion) — the announced-id set
    // must dedupe, or a duplicate evicts the oldest id at the cap and a delayed
    // ack for it looks unannounced.
    markVoiceTranscriptLanded('s1', 'hello', 'e-dup');
    markVoiceTranscriptLanded('s1', 'hello', 'e-dup');
    const marker = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1')
    );
    expect(marker.ids).toEqual(['e-dup']);
  });

  it('prefers this tab’s own backup over a newer foreign record', () => {
    // Two tabs hold deferred edits; the foreign record is NEWER, but
    // restoring it while this tab's own key holds DIFFERENT edits would
    // retire the wrong copy on reconciliation — recovery of an abandoned
    // foreign record happens only when this tab has none.
    vi.useRealTimers();
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.foreign-tab',
      JSON.stringify({ content: 'foreign edits', ts: Date.now() + 50_000, generation: 3 })
    );
    saveDraftBackup('s1', 'own edits', 3); // this tab's own (older) key
    // The landing must be live for a restore.
    markVoiceTranscriptLanded('s1', 'voice');
    expect(getDraftBackup('s1')).toBe('own edits');
  });

  it('keeps a fresh lower-generation backup restorable past an older supersede boundary', () => {
    vi.useRealTimers();
    // A tab stuck on an older generation (storage event unprocessed) writes a
    // FRESH backup AFTER the committed reconciliation's boundary: its edits
    // are newer user state and must stay restorable.
    const boundary = Date.now();
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1.5.1',
      JSON.stringify({ generation: 5, beforeTs: boundary })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.stuck-tab',
      JSON.stringify({ content: 'fresh old-gen edits', ts: boundary + 1000, generation: 2 })
    );
    expect(peekExpiredDraftBackup('s1')?.content).toBe('fresh old-gen edits');
    // A pre-boundary lower-generation backup is still superseded.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.stale-tab',
      JSON.stringify({ content: 'stale old-gen edits', ts: boundary - 1000, generation: 2 })
    );
    expect(peekExpiredDraftBackup('s1')?.content).toBe('fresh old-gen edits');
  });

  it('clears per-record supersede keys when a landing epoch restarts', () => {
    vi.useRealTimers();
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1.5.1',
      JSON.stringify({ generation: 5, beforeTs: Date.now() })
    );
    // No retained landed marker — a fresh epoch begins.
    markVoiceTranscriptLanded('s1', 'new voice', 'e-new');
    expect(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.superseded.s1.5.1')
    ).toBeNull();
  });

  it('re-unions the marker after a concurrent tab clobbers a surviving write', async () => {
    // A readback of our own write is not a compare-and-swap across tabs: a
    // writer that read the OLD marker can replace the union right after we
    // exit. The deferred verification passes must repair the aggregate — even
    // though the clobber's storage event REPLACED our local announced ids
    // with the incomplete marker's (only the ids OUR OWN cap evicted are
    // exempt from repair).
    markVoiceTranscriptLanded('s1', 'mine', 'e-mine');
    expect(getAnnouncedEntryIds('s1')).toContain('e-mine');
    // The stale-state writer's marker drops our entry entirely, and this tab
    // receives its storage event.
    const clobber = JSON.stringify({
      v: 1,
      ts: Date.now(),
      n: 999_999,
      text: 'theirs',
      ids: ['e-theirs'],
      entries: [{ id: 'e-theirs', text: 'theirs' }],
    });
    localStorage.setItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1', clobber);
    startVoiceTranscriptOutboxFlush();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
        newValue: clobber,
      })
    );
    // The authoritative replacement dropped our id from the local set…
    expect(getAnnouncedEntryIds('s1')).not.toContain('e-mine');
    await vi.advanceTimersByTimeAsync(3_000);
    const repaired = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1') ?? '{}'
    );
    // Both transcripts survive the repair — each writer unions from the other.
    expect(repaired.ids).toContain('e-mine');
    expect(repaired.ids).toContain('e-theirs');
    expect(getLandingTranscript('s1')).toContain('mine');
    expect(getLandingTranscript('s1')).toContain('theirs');
    stopVoiceTranscriptOutboxFlush();
  });

  it('advances the local signal to the newer persisted generation it reports', () => {
    // The save path tags backups with getLandingGeneration's answer; a later
    // consumption matches against the SIGNAL. Leaving the signal on the older
    // local generation would clear only an older backup while acking the
    // newer marker as consumed — the mismatched backup then restores
    // already-sent text through the peek paths.
    markVoiceTranscriptLanded('s1', 'local voice', 'e-local');
    const local = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    const newer = local + 500;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now(), n: newer, text: 'agg', ids: [] })
    );
    expect(getLandingGeneration('s1')).toBe(newer);
    expect(voiceTranscriptLandedSignal.value.get('s1')).toBe(newer);
    // A backup tagged with the EFFECTIVE generation is retired by a
    // consumption carrying that same generation.
    saveDraftBackup('s1', 'edits', newer);
    consumeVoiceTranscriptLanded('s1', newer);
    expect(peekExpiredDraftBackup('s1')).toBeNull();
  });

  it('unions the persisted marker ids with the local announced set', () => {
    vi.useRealTimers();
    // The local id set is THIS tab's memory of an earlier landing; another
    // tab can have announced a shared outbox entry in the persisted marker
    // before this tab's storage event is delivered. Shadowing the marker
    // with the local cache would re-announce the entry here, minting a
    // false landing whose reconciliation appends the aggregate again.
    markVoiceTranscriptLanded('s1', 'local voice', 'e-local', 1);
    const gen = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: gen + 500,
        text: null,
        ids: ['e-other-tab'],
        entries: [{ id: 'e-other-tab', text: 'other tab voice', seq: 2 }],
      })
    );
    const ids = getAnnouncedEntryIds('s1');
    expect(ids).toContain('e-local');
    expect(ids).toContain('e-other-tab');
  });

  it('starts a fresh epoch when the persisted marker has expired', () => {
    vi.useRealTimers();
    // A long-lived tab can age a marker past the TTL after the startup
    // prune already ran: treating the dead epoch as active would continue
    // its generation counter and skip the fresh-epoch supersede cleanup,
    // leaving the dead epoch's records suppressing the new epoch's
    // backups.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({
        v: 1,
        ts: Date.now() - 25 * 60 * 60 * 1000,
        n: 500,
        text: 'dead epoch voice',
        ids: ['e-dead'],
        entries: [{ id: 'e-dead', text: 'dead epoch voice', seq: 1 }],
      })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1.500.1',
      JSON.stringify({ generation: 500, beforeTs: Date.now() })
    );
    markVoiceTranscriptLanded('s1', 'new epoch voice', 'e-new');
    // The fresh-epoch cleanup removed the dead epoch's supersede record…
    expect(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.superseded.s1.500.1')
    ).toBeNull();
    // …and the dead aggregate did not prefix the new landing's text.
    expect(getLandingTranscript('s1')).toBe('new epoch voice');
  });

  it('hydrates the newer marker aggregate when advancing the local generation', () => {
    // Advancing the signal to a newer persisted marker must carry the SAME
    // marker's aggregate: the local landingTexts/Ids/Entries otherwise stay
    // on the old sequence and WIN the reads (getLandingTranscript prefers
    // local state), so a reconciliation without a structural baseline would
    // fold the STALE transcript into typing and later overwrite the daemon
    // draft without the new one.
    markVoiceTranscriptLanded('s1', 'local voice', 'e-local', 1);
    const local = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    const newer = local + 500;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: newer,
        text: 'marker aggregate',
        ids: ['e-marker'],
        entries: [{ id: 'e-marker', text: 'marker aggregate', seq: 2 }],
      })
    );
    expect(getLandingGeneration('s1')).toBe(newer);
    // The aggregate reads now follow the NEWER marker, not the stale local
    // marks — including the order-trust flag its entries recompute.
    expect(getLandingTranscript('s1')).toBe('marker aggregate');
    expect(getAnnouncedEntryIds('s1')).toContain('e-marker');
    expect(isLandingAggregateOrdered('s1')).toBe(true);
  });

  it('keeps every retained marker entry announced in ids when the union exceeds the cap', () => {
    vi.useRealTimers();
    // 19 local entries, then a persisted marker with two unseen entries: the
    // union exceeds the cap, so both bounded fields evict — but they must
    // evict the SAME entries. A retained entry missing from `ids` made a
    // delayed ack for it look unannounced, minting a false landing whose
    // fallback reconciliation appended its transcript again.
    for (let i = 0; i < 19; i++) markVoiceTranscriptLanded('s1', `local ${i}`, `L${i}`);
    const gen = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: gen + 500,
        text: null,
        ids: [],
        entries: [
          { id: 'P0', text: 'persisted 0' },
          { id: 'P1', text: 'persisted 1' },
        ],
      })
    );
    markVoiceTranscriptLanded('s1', 'latest', 'L19'); // triggers the union rewrite
    const marker = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1') ?? '{}'
    );
    expect(marker.ids).toContain('L0'); // oldest retained local entry stays announced
    expect(marker.entries.every((e: { id: string }) => marker.ids.includes(e.id))).toBe(true);
  });

  it('orders landing entries by daemon commit sequence, not arrival', () => {
    vi.useRealTimers();
    // In one tab, the SECOND entry's acknowledgement landed first; the
    // aggregate must still read in daemon commit order or it no longer
    // tail-matches the merged draft during reconciliation.
    markVoiceTranscriptLanded('s1', 'committed second', 'e2', 2);
    markVoiceTranscriptLanded('s1', 'committed first', 'e1', 1);
    expect(getLandingTranscript('s1')).toBe('committed first committed second');

    // Cross-tab: the persisted marker's earliest entry unions in AFTER later
    // local entries — commit order still wins over arrival order.
    const gen = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: gen + 500,
        text: null,
        ids: [],
        entries: [{ id: 'e0', text: 'committed earliest', seq: 0 }],
      })
    );
    markVoiceTranscriptLanded('s1', 'committed last', 'e3', 3);
    expect(getLandingTranscript('s1')).toBe(
      'committed earliest committed first committed second committed last'
    );
  });

  it('suppresses a backup against EVERY nondominated supersede boundary', () => {
    vi.useRealTimers();
    // A lower-generation record can carry a LATER timestamp than a
    // higher-generation one (an older-generation tab whose reconciliation
    // committed last): selecting one lexicographic maximum would restore a
    // backup the other record had ruled out.
    const now = Date.now();
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1.10.1',
      JSON.stringify({ generation: 10, beforeTs: now - 1000 })
    );
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1.9.2',
      JSON.stringify({ generation: 9, beforeTs: now - 500 })
    );
    // Covered by the (9, now-500) boundary even though the lexicographic
    // maximum is (10, now-1000) — must stay unrestorable.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.stale-tab',
      JSON.stringify({ content: 'suppressed edits', ts: now - 750, generation: 9 })
    );
    // Newer than BOTH boundaries — still restorable.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.draft.s1.live-tab',
      JSON.stringify({ content: 'newer edits', ts: now - 250, generation: 9 })
    );
    expect(peekExpiredDraftBackup('s1')?.content).toBe('newer edits');
  });

  it('does not repair ids the entry cap legitimately evicted', async () => {
    // A rapid drain past the entry cap evicts older ids from BOTH the marker
    // and the local aggregate — the verification must not read that eviction
    // as a cross-tab clobber and mint a false landing (which would append the
    // aggregate again during reconciliation, duplicating voice text).
    for (let i = 0; i < 25; i++) markVoiceTranscriptLanded('s1', `t${i}`, `e${i}`, i + 1);
    const gen = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(voiceTranscriptLandedSignal.value.get('s1') ?? 0).toBe(gen);
  });

  it('keeps legacy unsequenced entries ahead of sequenced ones', () => {
    vi.useRealTimers();
    // A marker written by the previous version carries entries without `seq`;
    // the daemon appended those transcripts BEFORE any sequenced entry, so
    // they order at the FRONT — sorting them last would reverse the aggregate
    // relative to the merged draft right after the upgrade. The mixed union's
    // ORDER is untrustworthy either way, so the aggregate is marked unordered
    // for reconciliation trust (below).
    markVoiceTranscriptLanded('s1', 'new entry', 'e-new', 5);
    const gen = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: gen + 500,
        text: null,
        ids: [],
        entries: [{ id: 'e-legacy', text: 'legacy entry' }],
      })
    );
    markVoiceTranscriptLanded('s1', 'trigger', 'e-trig', 6);
    expect(getLandingTranscript('s1')).toBe('legacy entry new entry trigger');
  });

  it('flags a mixed-sequenced union as order-untrusted, pure sequences as trusted', () => {
    vi.useRealTimers();
    // A stale pre-upgrade tab can still publish UNSEQUENCED entries after
    // sequenced ones committed — no client-side comparator can order them
    // against each other. The aggregate keeps every entry but reconciliation
    // must not tail-match or restore from the unordered mix.
    markVoiceTranscriptLanded('s1', 'first', 'e1', 1);
    markVoiceTranscriptLanded('s1', 'second', 'e2', 2);
    expect(isLandingAggregateOrdered('s1')).toBe(true);
    const gen = voiceTranscriptLandedSignal.value.get('s1') ?? 0;
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: gen + 500,
        text: null,
        ids: [],
        entries: [{ id: 'e-stale-client', text: 'stale client entry' }],
      })
    );
    markVoiceTranscriptLanded('s1', 'third', 'e3', 3);
    expect(isLandingAggregateOrdered('s1')).toBe(false);
    // Every entry survives; only the ORDER trust changed.
    expect(getLandingTranscript('s1')).toContain('stale client entry');
    expect(getLandingTranscript('s1')).toContain('first');
  });

  it('keeps verifying later sequences after an earlier marker was consumed', async () => {
    // A same-tab landing updates the signal BEFORE writing its new marker, so
    // a liveness probe during the write still sees the CONSUMED raw value —
    // gating on "ever consumed" would disable verification for every later
    // sequence of the session. Only the CURRENT raw being the consumed one
    // disarms the repair.
    markVoiceTranscriptLanded('s1', 'first sequence', 'e1', 1);
    consumeVoiceTranscriptLanded('s1', voiceTranscriptLandedSignal.value.get('s1') ?? 1);
    markVoiceTranscriptLanded('s1', 'second sequence', 'e2', 2);
    // A stale-state writer clobbers the second sequence's marker.
    const clobber = JSON.stringify({
      v: 1,
      ts: Date.now(),
      n: 999_999,
      text: 'theirs',
      ids: ['e-theirs'],
      entries: [{ id: 'e-theirs', text: 'theirs' }],
    });
    localStorage.setItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1', clobber);
    startVoiceTranscriptOutboxFlush();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
        newValue: clobber,
      })
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const repaired = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1') ?? '{}'
    );
    expect(repaired.ids).toContain('e2');
    expect(repaired.ids).toContain('e-theirs');
    stopVoiceTranscriptOutboxFlush();
  });

  it('shares the repair budget across repair chains, re-arming per genuine landing', async () => {
    // A repair's own mark schedules a fresh verification chain; if that chain
    // re-initialized the per-session budget, a stale-state writer that keeps
    // overwriting the marker could churn repair timers and marker writes
    // forever. Repair-triggered chains must SHARE the remaining budget —
    // three repairs, then silence — while a genuinely NEW landing re-arms it.
    const markerKey = 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1';
    const backing = globalThis.localStorage;
    startVoiceTranscriptOutboxFlush();
    // The genuine landing writes CLEANLY (its readback must survive so the
    // first chain is scheduled with a fresh budget).
    markVoiceTranscriptLanded('s1', 'mine', 'e-mine');
    // A stale-state writer clobbers right after every union write: the clobber
    // lands in a MICROTASK, so the writing tab's synchronous CAS readback
    // still observes its own write and schedules the follow-up chain — the
    // exact interleave the bounded-repair safeguard exists for.
    let clobberN = 0;
    const markerWrites: string[] = [];
    const clobber = () => {
      clobberN += 1;
      return JSON.stringify({
        v: 1,
        ts: Date.now(),
        n: 1_000_000 + clobberN,
        text: 'theirs',
        ids: ['e-theirs'],
        entries: [{ id: 'e-theirs', text: 'theirs' }],
      });
    };
    globalThis.localStorage = {
      get length() {
        return backing.length;
      },
      clear: () => backing.clear(),
      getItem: (k) => backing.getItem(k),
      key: (i) => backing.key(i),
      removeItem: (k) => backing.removeItem(k),
      setItem: (k, v) => {
        backing.setItem(k, String(v));
        if (k !== markerKey) return;
        markerWrites.push(String(v));
        const next = clobber();
        queueMicrotask(() => {
          backing.setItem(markerKey, next);
          window.dispatchEvent(new StorageEvent('storage', { key: markerKey, newValue: next }));
        });
      },
    } as Storage;
    // The first clobber precedes any verification pass.
    const first = clobber();
    backing.setItem(markerKey, first);
    window.dispatchEvent(new StorageEvent('storage', { key: markerKey, newValue: first }));
    await vi.advanceTimersByTimeAsync(30_000);
    // Three repairs (the initial budget), then the cascade stops despite the
    // marker still being clobbered after every write.
    expect(markerWrites.filter((v) => v.includes('e-mine'))).toHaveLength(3);
    // A genuinely NEW landing re-arms the budget for the new sequence: its
    // chain repairs the fresh entry's clobber three more times (the genuine
    // write itself plus three repairs = four writes carrying the entry).
    markVoiceTranscriptLanded('s1', 'fresh voice', 'e-fresh');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(markerWrites.filter((v) => v.includes('e-fresh'))).toHaveLength(4);
    stopVoiceTranscriptOutboxFlush();
  });

  it('revalidates epoch ownership before deleting supersede records', () => {
    vi.useRealTimers();
    // Two tabs read an absent marker; tab A establishes the epoch and
    // reconciles (writing its supersede record) before tab B's delayed mark
    // runs its cleanup — B must re-check that the marker is STILL absent, or
    // it deletes A's fresh record and a ruled-out backup restores.
    const markerKey = 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1';
    const recordKey = 'hyperneo_voice_transcript_outbox_v1.superseded.s1.3.1';
    localStorage.setItem(recordKey, JSON.stringify({ generation: 3, beforeTs: Date.now() }));
    const realGetItem = localStorage.getItem.bind(localStorage);
    const concurrentMarker = JSON.stringify({
      v: 1,
      ts: Date.now(),
      n: 5,
      text: 'their epoch',
      ids: ['e-a'],
    });
    let reads = 0;
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      if (key === markerKey) {
        reads += 1;
        // read #1 (the initial, stale) sees no marker; a concurrent tab
        // establishes the epoch immediately after — every later read sees it.
        if (reads === 1) return null;
        return concurrentMarker;
      }
      return realGetItem(key);
    });
    markVoiceTranscriptLanded('s1', 'delayed tab', 'e-late');
    spy.mockRestore();
    // The fresh epoch's record survived the delayed tab's cleanup.
    expect(localStorage.getItem(recordKey)).not.toBeNull();
  });

  it('stops epoch deletions the moment a new marker appears mid-removal', () => {
    vi.useRealTimers();
    // The pre-scan recheck passed, but a second tab establishes the new epoch
    // DURING the removal loop: its marker lands (markers are always written
    // before their epoch's records), so the very next per-record recheck must
    // abort the remaining deletions.
    const markerKey = 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1';
    const recordA = 'hyperneo_voice_transcript_outbox_v1.superseded.s1.1.1';
    const recordB = 'hyperneo_voice_transcript_outbox_v1.superseded.s1.2.2';
    localStorage.setItem(recordA, JSON.stringify({ generation: 1, beforeTs: Date.now() }));
    localStorage.setItem(recordB, JSON.stringify({ generation: 2, beforeTs: Date.now() }));
    const realRemove = localStorage.removeItem.bind(localStorage);
    let removals = 0;
    const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
      if (key === recordA || key === recordB) {
        removals += 1;
        if (removals === 1) {
          // The concurrent tab establishes the epoch mid-loop.
          localStorage.setItem(
            markerKey,
            JSON.stringify({ v: 1, ts: Date.now(), n: 5, text: 'new epoch', ids: [] })
          );
        }
        realRemove(key);
        return;
      }
      realRemove(key);
    });
    markVoiceTranscriptLanded('s1', 'delayed tab', 'e-late');
    spy.mockRestore();
    // The first record was already gone, but the loop aborted before the new
    // epoch's second record.
    expect(localStorage.getItem(recordA)).toBeNull();
    expect(localStorage.getItem(recordB)).not.toBeNull();
  });

  it('does not duplicate an entry the local aggregate still holds when repairing', async () => {
    // The clobbering tab's storage event is still QUEUED when verification
    // runs: the persisted marker lacks an announced id while the local
    // records still hold that same entry. The repair's re-mark must REPLACE
    // the record, not append alongside it — the aggregate text would carry
    // the transcript twice, and a later fallback fold persists the duplicate.
    markVoiceTranscriptLanded('s1', 'mine', 'e-mine', 1);
    const clobber = JSON.stringify({
      v: 1,
      ts: Date.now(),
      n: 999_999,
      text: 'theirs',
      ids: ['e-theirs'],
      entries: [{ id: 'e-theirs', text: 'theirs' }],
    });
    localStorage.setItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1', clobber);
    // No storage event dispatched — the local aggregate still holds e-mine.
    await vi.advanceTimersByTimeAsync(3_000);
    const repaired = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1') ?? '{}'
    );
    expect(repaired.entries.filter((e: { id: string }) => e.id === 'e-mine')).toHaveLength(1);
    expect(getLandingTranscript('s1').match(/mine/g)?.length).toBe(1);
  });

  it('ignores a queued storage event describing a superseded marker', () => {
    vi.useRealTimers();
    startVoiceTranscriptOutboxFlush();
    markVoiceTranscriptLanded('s1', 'newer voice', 'e-new');
    // A queued event for the OLDER marker another tab wrote BEFORE ours
    // published: the stored value is ours now, so the event is historical —
    // replaceAggregate would otherwise roll the local aggregate (which
    // getLandingTranscript prefers) back to the stale text.
    const staleMarker = JSON.stringify({
      v: 1,
      ts: Date.now() - 1000,
      n: 1,
      text: 'older voice',
      ids: ['e-old'],
      entries: [{ id: 'e-old', text: 'older voice' }],
    });
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
        newValue: staleMarker,
      })
    );
    expect(getLandingTranscript('s1')).toBe('newer voice');
    stopVoiceTranscriptOutboxFlush();
  });

  it('treats a multi-entry unsequenced aggregate as order-untrusted', () => {
    vi.useRealTimers();
    // One unsequenced entry is trivially ordered; TWO have no order evidence
    // at all (stale pre-upgrade bundles append without `seq`, and acks can
    // publish in the opposite order from daemon commits).
    markVoiceTranscriptLanded('s1', 'only one');
    expect(isLandingAggregateOrdered('s1')).toBe(true);
    markVoiceTranscriptLanded('s1', 'a second');
    expect(isLandingAggregateOrdered('s1')).toBe(false);
  });

  it('preserves a legacy marker aggregate through later landings', () => {
    vi.useRealTimers();
    // A pre-entries marker carries text/ids but no records: without an
    // explicit legacy record, the next landing's rebuild derives text solely
    // from entries and silently drops the legacy transcript while its id
    // stays announced.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
      JSON.stringify({ v: 1, ts: Date.now(), n: 3, text: 'legacy voice', ids: ['e1'] })
    );
    markVoiceTranscriptLanded('s1', 'fresh voice', 'e2', 1);
    markVoiceTranscriptLanded('s1', 'more voice', 'e3', 2);
    const text = getLandingTranscript('s1') ?? '';
    expect(text).toContain('legacy voice');
    expect(text).toContain('fresh voice');
    expect(text).toContain('more voice');
  });

  it('marks a capped aggregate untrusted, persists the eviction, and re-trusts after settlement', () => {
    vi.useRealTimers();
    // More than MAX_ENTRIES transcripts in one sequence: the retained
    // all-sequenced tail is still a TRUNCATED sequence — fallback restoration
    // would fold only the last 20 transcripts. The distrust is persisted in
    // the marker (a hydrating reload reads the same flag), and consuming the
    // sequence wipes the slate so the next landing starts trusted.
    for (let i = 0; i < 25; i++) markVoiceTranscriptLanded('s1', `t${i}`, `e${i}`, i + 1);
    expect(isLandingAggregateOrdered('s1')).toBe(false);
    const marker = JSON.parse(
      localStorage.getItem('hyperneo_voice_transcript_outbox_v1.entry.landed.s1') ?? '{}'
    );
    expect(marker.evicted).toBe(true);
    consumeVoiceTranscriptLanded('s1', voiceTranscriptLandedSignal.value.get('s1') ?? 0);
    markVoiceTranscriptLanded('s1', 'fresh', 'e-new', 26);
    expect(isLandingAggregateOrdered('s1')).toBe(true);
  });
});
