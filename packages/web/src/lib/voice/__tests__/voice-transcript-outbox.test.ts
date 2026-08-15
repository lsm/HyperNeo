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

import {
  consumeVoiceTranscriptLanded,
  enqueueTranscript,
  flushPendingTranscripts,
  getAnnouncedEntryIds,
  getDraftBackup,
  getLandingTranscript,
  getPendingTranscripts,
  hasClearTombstone,
  isLandingLive,
  getLandingGeneration,
  markVoiceTranscriptLanded,
  peekExpiredDraftBackup,
  readTabId,
  removeDraftBackupKey,
  removeClearTombstone,
  removePendingTranscript,
  resetVoiceTranscriptOutbox,
  retireDraftBackupClaim,
  saveClearTombstone,
  saveDraftBackup,
  startVoiceTranscriptOutboxFlush,
  stopVoiceTranscriptOutboxFlush,
  voiceTranscriptLandedSignal,
} from '../voice-transcript-outbox.ts';
import { connectionManager } from '../../connection-manager.ts';
import { connectionState } from '../../state.ts';

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
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s1',
        newValue: JSON.stringify({ v: 1, ts: Date.now(), n: 9, text: 'authoritative' }),
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
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'hyperneo_voice_transcript_outbox_v1.entry.landed.s3',
        newValue: JSON.stringify({ v: 1, ts: Date.now(), n: 1, text: 'cross-tab' }),
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
    // acknowledgement must not move the marker backward and un-supersede a
    // sibling the newer marker already ruled out.
    localStorage.setItem(
      'hyperneo_voice_transcript_outbox_v1.superseded.s1',
      JSON.stringify({ generation: 2, beforeTs: Date.now() + 5000 })
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
    // The stronger (generation-2) marker survives the late write.
    expect(
      JSON.parse(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.superseded.s1') ?? '{}')
    ).toEqual({ generation: 2, beforeTs: expect.any(Number) });
    // A same-generation LATER claim still advances the marker.
    const newerClaim = {
      key: 'hyperneo_voice_transcript_outbox_v1.draft.s1.newest-tab',
      generation: 2,
      ts: Date.now() + 6000,
    };
    localStorage.setItem(
      newerClaim.key,
      JSON.stringify({ content: 'newest edits', ts: newerClaim.ts, generation: 2 })
    );
    retireDraftBackupClaim(newerClaim);
    expect(
      JSON.parse(localStorage.getItem('hyperneo_voice_transcript_outbox_v1.superseded.s1') ?? '{}')
    ).toEqual({ generation: 2, beforeTs: newerClaim.ts });
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

  it('delivers the OLDEST batch when concurrent enqueues exceed the cap', () => {
    // Two tabs' pre-write prunes cannot see each other's writes, so more
    // than 20 live keys can exist. The flush batch must start at the OLDEST
    // entry, or the hidden older transcript would append AFTER the newer
    // ones and reverse the order the user dictated them in.
    for (let i = 0; i < 25; i++) {
      localStorage.setItem(
        `hyperneo_voice_transcript_outbox_v1.entry.over-${i}`,
        JSON.stringify({
          id: `over-${i}`,
          sessionId: 's1',
          text: `t${i}`,
          createdAt: Date.now() + i,
        })
      );
    }
    const pending = getPendingTranscripts();
    expect(pending).toHaveLength(20);
    expect(pending[0].text).toBe('t0'); // oldest-first
    expect(pending[19].text).toBe('t19');
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
