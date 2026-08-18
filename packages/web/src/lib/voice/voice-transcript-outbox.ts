import { effect, signal } from '@preact/signals';
import { appendDraftText, generateUUID } from '@hyperneo/shared';
import { connectionManager } from '../connection-manager';
import { connectionState } from '../state';

export interface PendingTranscript {
  id: string;
  sessionId: string;
  text: string;
  createdAt: number;
}

export const voiceTranscriptLandedSignal = signal<ReadonlyMap<string, number>>(new Map());

export function markVoiceTranscriptLanded(
  sessionId: string,
  text?: string,
  entryId?: string
): void {
  let seq = Math.max(1, Date.now() + TAB_SEQ_OFFSET);
  let markerExisted = false;
  let existing: ReturnType<typeof parseLandedMarker> = null;
  let rawMarker: string | null = null;
  try {
    rawMarker = localStorage.getItem(`${LANDED_PREFIX}${sessionId}`);
    existing = parseLandedMarker(rawMarker);
    if (existing) {
      markerExisted = true;
      seq = Math.max(existing.n + 1 + TAB_SEQ_OFFSET, Date.now() + TAB_SEQ_OFFSET);
    }
  } catch {
    /* storage unavailable — start a fresh sequence */
  }
  if (!markerExisted) {
    try {
      localStorage.removeItem(`${SUPERSEDED_PREFIX}${sessionId}`);
    } catch {
      /* storage unavailable */
    }
  }
  markVoiceTranscriptLandedLocal(sessionId, text, false, seq, entryId);
  const consumeMarker = (marker: ReturnType<typeof parseLandedMarker>): void => {
    if (!marker) return;
    const ours = new Set(landingIds.get(sessionId) ?? []);
    if (marker.entries.length > 0) {
      let appended = false;
      for (const entry of marker.entries) {
        if (ours.has(entry.id)) continue;
        landingTexts.set(sessionId, appendDraftText(landingTexts.get(sessionId) ?? '', entry.text));
        ours.add(entry.id);
        appended = true;
      }
      if (appended) {
        landingIds.set(sessionId, [...ours].slice(-MAX_ENTRIES));
        const known = new Set((landingEntries.get(sessionId) ?? []).map((e) => e.id));
        const mergedEntries = [
          ...(landingEntries.get(sessionId) ?? []),
          ...marker.entries.filter((e) => !known.has(e.id)),
        ];
        landingEntries.set(sessionId, mergedEntries.slice(-MAX_ENTRIES));
      }
      return;
    }
    if (marker.text && marker.ids.some((id) => !ours.has(id))) {
      landingTexts.set(sessionId, appendDraftText(landingTexts.get(sessionId) ?? '', marker.text));
    }
    if (marker.ids.length) {
      const mergedIds = new Set(landingIds.get(sessionId) ?? []);
      for (const id of marker.ids) mergedIds.add(id);
      landingIds.set(sessionId, [...mergedIds].slice(-MAX_ENTRIES));
    }
  };
  const consumedRaw = (raw: string | null): boolean =>
    raw !== null && consumedMarkers.get(sessionId) === raw;
  if (!consumedRaw(rawMarker)) consumeMarker(existing);
  try {
    const key = `${LANDED_PREFIX}${sessionId}`;
    let markerRaw = rawMarker;
    for (let attempt = 0; attempt < 3; attempt++) {
      const currentRaw = localStorage.getItem(key);
      if (currentRaw !== markerRaw && !consumedRaw(currentRaw)) {
        consumeMarker(parseLandedMarker(currentRaw));
      }
      localStorage.setItem(
        key,
        JSON.stringify({
          v: 1,
          ts: Date.now(),
          n: seq,
          text: landingTexts.get(sessionId) ?? null,
          ids: landingIds.get(sessionId) ?? [],
          entries: landingEntries.get(sessionId) ?? [],
        })
      );
      markerRaw = localStorage.getItem(key);
      if (markerRaw === null) break;
    }
  } catch {
    /* mirror-only — this tab still refreshes via the signal */
  }
}

const landingMarkedAt = new Map<string, number>();
const landingTexts = new Map<string, string>();
const landingIds = new Map<string, string[]>();
export interface LandingEntry {
  id: string;
  text: string;
}
const landingEntries = new Map<string, LandingEntry[]>();
let syntheticEntryCounter = 0;

function markVoiceTranscriptLandedLocal(
  sessionId: string,
  text?: string | null,
  replaceAggregate = false,
  explicitGeneration?: number,
  entryId?: string,
  markerIds?: string[],
  markerEntries?: LandingEntry[]
): void {
  const current = voiceTranscriptLandedSignal.value;
  const hadLiveLanding = current.has(sessionId);
  const next = new Map(current);
  const generation =
    explicitGeneration !== undefined
      ? Math.max(current.get(sessionId) ?? 0, explicitGeneration)
      : (current.get(sessionId) ?? 0) + 1;
  next.set(sessionId, generation);
  voiceTranscriptLandedSignal.value = next;
  landingMarkedAt.set(sessionId, Date.now());
  if (typeof text === 'string') {
    const prev = hadLiveLanding && !replaceAggregate ? (landingTexts.get(sessionId) ?? '') : '';
    landingTexts.set(sessionId, prev ? appendDraftText(prev, text) : text);
  }
  if (typeof text === 'string') {
    const record: LandingEntry = {
      id: entryId ?? `synthetic-${++syntheticEntryCounter}`,
      text,
    };
    const fresh = hadLiveLanding && !replaceAggregate;
    const prevEntries = fresh ? (landingEntries.get(sessionId) ?? []) : [];
    landingEntries.set(sessionId, [...prevEntries, record].slice(-MAX_ENTRIES));
    const prevIds = fresh ? (landingIds.get(sessionId) ?? []) : [];
    landingIds.set(sessionId, [...new Set([...prevIds, record.id])].slice(-MAX_ENTRIES));
  }
  if (entryId !== undefined) {
    const prevIds = hadLiveLanding ? (landingIds.get(sessionId) ?? []) : [];
    landingIds.set(sessionId, [...prevIds, entryId].slice(-MAX_ENTRIES));
  } else if (replaceAggregate) {
    landingIds.set(sessionId, (markerIds ?? []).slice(-MAX_ENTRIES));
    if (markerEntries) landingEntries.set(sessionId, markerEntries.slice(-MAX_ENTRIES));
  }
}

export function getLandingGeneration(sessionId: string): number | undefined {
  const local = voiceTranscriptLandedSignal.value.get(sessionId);
  if (local !== undefined) return local;
  try {
    const marker = parseLandedMarker(localStorage.getItem(`${LANDED_PREFIX}${sessionId}`));
    return marker?.n;
  } catch {
    return undefined;
  }
}

export function getLandingTranscript(sessionId: string): string | null {
  const local = landingTexts.get(sessionId);
  if (local !== undefined) return local;
  try {
    return parseLandedMarker(localStorage.getItem(`${LANDED_PREFIX}${sessionId}`))?.text ?? null;
  } catch {
    return null;
  }
}

export function getAnnouncedEntryIds(sessionId: string): string[] {
  const local = landingIds.get(sessionId);
  if (local !== undefined) return local;
  try {
    return parseLandedMarker(localStorage.getItem(`${LANDED_PREFIX}${sessionId}`))?.ids ?? [];
  } catch {
    return [];
  }
}

function parseLandedMarker(raw: string | null): {
  ts: number;
  n: number;
  text: string | null;
  ids: string[];
  entries: LandingEntry[];
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      ts?: unknown;
      n?: unknown;
      text?: unknown;
      ids?: unknown;
      entries?: unknown;
    };
    if (typeof parsed.ts !== 'number') return null;
    const entries: LandingEntry[] = Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (e): e is LandingEntry =>
            !!e &&
            typeof (e as LandingEntry).id === 'string' &&
            typeof (e as LandingEntry).text === 'string'
        )
      : [];
    let text: string | null = typeof parsed.text === 'string' ? parsed.text : null;
    if (text === null && entries.length > 0) {
      text = entries.reduce((acc, e) => appendDraftText(acc, e.text), '');
    }
    let ids: string[] = Array.isArray(parsed.ids)
      ? parsed.ids.filter((id): id is string => typeof id === 'string')
      : [];
    if (ids.length === 0 && entries.length > 0) ids = entries.map((e) => e.id);
    return {
      ts: parsed.ts,
      n: typeof parsed.n === 'number' ? parsed.n : 0,
      text,
      ids,
      entries,
    };
  } catch {
    return null;
  }
}

function dropLocalLanding(sessionId: string): void {
  const current = voiceTranscriptLandedSignal.value;
  if (!current.has(sessionId)) return;
  const next = new Map(current);
  next.delete(sessionId);
  voiceTranscriptLandedSignal.value = next;
  landingTexts.delete(sessionId);
  landingIds.delete(sessionId);
  landingEntries.delete(sessionId);
}

export function consumeVoiceTranscriptLanded(sessionId: string, generation: number): void {
  const current = voiceTranscriptLandedSignal.value;
  if (current.get(sessionId) !== generation) return;
  const next = new Map(current);
  next.delete(sessionId);
  voiceTranscriptLandedSignal.value = next;
  try {
    const raw = localStorage.getItem(`${LANDED_PREFIX}${sessionId}`);
    if (raw !== null) consumedMarkers.set(sessionId, raw);
  } catch {
    /* storage unavailable — no marker, nothing to acknowledge */
  }
  clearDraftBackup(sessionId, generation);
}

const consumedMarkers = new Map<string, string>();

const DRAFT_BACKUP_TTL_MS = 24 * 60 * 60 * 1000;

export function readTabId(): string {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem('hyperneo_tab_id');
  } catch {
    return generateUUID();
  }
  if (!stored) {
    const id = generateUUID();
    try {
      sessionStorage.setItem('hyperneo_tab_id', id);
    } catch {
      /* best-effort persistence */
    }
    return id;
  }
  try {
    const raw = localStorage.getItem(`hyperneo_tab_heartbeat.${stored}`);
    const beat = raw === null ? 0 : Number(raw);
    if (Number.isFinite(beat) && Date.now() - beat < TAB_HEARTBEAT_FRESH_MS) {
      const id = generateUUID();
      sessionStorage.setItem('hyperneo_tab_id', id);
      return id;
    }
  } catch {
    /* storage unavailable — keep the stored id */
  }
  return stored;
}

const TAB_HEARTBEAT_FRESH_MS = 90_000;
const TAB_HEARTBEAT_INTERVAL_MS = 2000;

const TAB_ID = readTabId();

try {
  const heartbeatKey = `hyperneo_tab_heartbeat.${TAB_ID}`;
  const beat = () => {
    try {
      localStorage.setItem(heartbeatKey, String(Date.now()));
    } catch {
      /* best-effort liveness */
    }
  };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat = () => {
    if (heartbeatTimer !== null) return;
    beat();
    heartbeatTimer = setInterval(beat, TAB_HEARTBEAT_INTERVAL_MS);
    window.addEventListener('pagehide', stopHeartbeat, { once: true });
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      localStorage.removeItem(heartbeatKey);
    } catch {
      /* best-effort */
    }
  };
  window.addEventListener('visibilitychange', beat);
  window.addEventListener('pageshow', (event) => {
    beat();
    if ((event as PageTransitionEvent).persisted) startHeartbeat();
  });
  window.addEventListener('resume', beat);
  startHeartbeat();
} catch {
  /* storage unavailable — clone detection degrades to the stored id */
}

const TAB_SEQ_OFFSET = (() => {
  let hash = 0;
  for (let i = 0; i < TAB_ID.length; i++) hash = (hash * 31 + TAB_ID.charCodeAt(i)) % 997;
  return hash;
})();

function draftBackupKey(sessionId: string): string {
  return `${DRAFT_BACKUP_PREFIX}${sessionId}.${TAB_ID}`;
}

export interface DraftBackupClaim {
  key: string;
  content: string;
  generation: number;
  ts: number;
}

const SUPERSEDED_PREFIX = 'hyperneo_voice_transcript_outbox_v1.superseded.';

function readSuperseded(sessionId: string): { generation: number; beforeTs: number } | null {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(`${SUPERSEDED_PREFIX}${sessionId}`) ?? 'null'
    ) as { generation?: unknown; beforeTs?: unknown } | null;
    if (parsed && typeof parsed.generation === 'number' && typeof parsed.beforeTs === 'number') {
      return { generation: parsed.generation, beforeTs: parsed.beforeTs };
    }
    return null;
  } catch {
    return null;
  }
}

function ownerClearTombstoneTs(sessionId: string, owner: string): number | null {
  try {
    const raw = localStorage.getItem(`${CLEAR_TOMBSTONE_PREFIX}${sessionId}.${owner}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { ts?: number } | null;
    if (!parsed || typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts >= DRAFT_BACKUP_TTL_MS) return null;
    return parsed.ts;
  } catch {
    return null;
  }
}

function freshestDraftBackup(sessionId: string): DraftBackupClaim | null {
  let freshest: DraftBackupClaim | null = null;
  const superseded = readSuperseded(sessionId);
  try {
    const staleKeys: string[] = [];
    const prefix = `${DRAFT_BACKUP_PREFIX}${sessionId}.`;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        content?: unknown;
        ts?: unknown;
        generation?: unknown;
      } | null;
      if (!parsed || typeof parsed.content !== 'string') continue;
      const ts = typeof parsed.ts === 'number' ? parsed.ts : 0;
      if (Date.now() - ts >= DRAFT_BACKUP_TTL_MS) {
        staleKeys.push(key);
        continue;
      }
      const generation = typeof parsed.generation === 'number' ? parsed.generation : 0;
      if (
        superseded &&
        (generation < superseded.generation ||
          (generation === superseded.generation && ts <= superseded.beforeTs))
      ) {
        continue;
      }
      const owner = key.slice(key.lastIndexOf('.') + 1);
      const clearedAt = ownerClearTombstoneTs(sessionId, owner);
      if (clearedAt !== null && ts <= clearedAt) continue;
      if (!freshest || ts >= freshest.ts) {
        freshest = { key, content: parsed.content, generation, ts };
      }
    }
    for (const key of staleKeys) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
  return freshest;
}

export function saveDraftBackup(sessionId: string, content: string, generation: number): boolean {
  try {
    localStorage.setItem(
      draftBackupKey(sessionId),
      JSON.stringify({ content, ts: Date.now(), generation })
    );
    return true;
  } catch {
    return false;
  }
}

export function isLandingLive(sessionId: string): boolean {
  if (voiceTranscriptLandedSignal.value.has(sessionId)) {
    const markedAt = landingMarkedAt.get(sessionId);
    if (markedAt === undefined || Date.now() - markedAt < MAX_AGE_MS) return true;
    dropLocalLanding(sessionId);
  }
  try {
    const raw = localStorage.getItem(`${LANDED_PREFIX}${sessionId}`);
    if (!raw) return false;
    const marker = parseLandedMarker(raw);
    if (!marker || Date.now() - marker.ts >= MAX_AGE_MS) return false;
    if (consumedMarkers.get(sessionId) === raw) return false;
    if (consumedMarkers.has(sessionId)) consumedMarkers.delete(sessionId);
    return true;
  } catch {
    return false;
  }
}

export function getDraftBackup(sessionId: string): string | null {
  const claim = freshestDraftBackup(sessionId);
  if (!claim) return null;
  if (!isLandingLive(sessionId)) return null;
  return claim.content;
}

export function clearDraftBackup(sessionId: string, generation?: number): void {
  removeDraftBackupKey(draftBackupKey(sessionId), generation);
}

export function removeDraftBackupKey(key: string, generation?: number, expectedTs?: number): void {
  try {
    if (generation !== undefined || expectedTs !== undefined) {
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        generation?: number;
        ts?: number;
      } | null;
      if (generation !== undefined && parsed?.generation !== generation) return;
      if (expectedTs !== undefined && parsed?.ts !== expectedTs) return;
    }
    localStorage.removeItem(key);
  } catch {
    /* backup best-effort */
  }
}

export function retireDraftBackupClaim(claim: {
  key: string;
  generation: number;
  ts: number;
}): void {
  removeDraftBackupKey(claim.key, claim.generation, claim.ts);
  try {
    const sessionId = claim.key.slice(DRAFT_BACKUP_PREFIX.length, claim.key.lastIndexOf('.'));
    const existing = readSuperseded(sessionId);
    const stronger =
      !!existing &&
      (existing.generation > claim.generation ||
        (existing.generation === claim.generation && existing.beforeTs >= claim.ts));
    if (!stronger) {
      localStorage.setItem(
        `${SUPERSEDED_PREFIX}${sessionId}`,
        JSON.stringify({ generation: claim.generation, beforeTs: claim.ts })
      );
    }
  } catch {
    /* marker best-effort — the claimed key itself is already retired */
  }
}

export function saveClearTombstone(sessionId: string, baselineSeq?: number): boolean {
  try {
    const key = `${CLEAR_TOMBSTONE_PREFIX}${sessionId}.${TAB_ID}`;
    let seqToWrite = baselineSeq;
    if (seqToWrite === undefined) {
      const existing = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        baselineSeq?: number;
      } | null;
      if (typeof existing?.baselineSeq === 'number') seqToWrite = existing.baselineSeq;
    }
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), baselineSeq: seqToWrite }));
    return true;
  } catch {
    return false;
  }
}

export function getClearTombstone(sessionId: string): { ts: number; baselineSeq?: number } | null {
  try {
    const raw = localStorage.getItem(`${CLEAR_TOMBSTONE_PREFIX}${sessionId}.${TAB_ID}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts?: number; baselineSeq?: number };
    if (typeof parsed.ts !== 'number') return null;
    if (Date.now() - parsed.ts >= DRAFT_BACKUP_TTL_MS) return null;
    return typeof parsed.baselineSeq === 'number'
      ? { ts: parsed.ts, baselineSeq: parsed.baselineSeq }
      : { ts: parsed.ts };
  } catch {
    return null;
  }
}

export function hasClearTombstone(sessionId: string): boolean {
  return getClearTombstone(sessionId) !== null;
}

export function removeClearTombstone(sessionId: string): void {
  try {
    localStorage.removeItem(`${CLEAR_TOMBSTONE_PREFIX}${sessionId}.${TAB_ID}`);
  } catch {
    /* tombstone best-effort */
  }
}

export function peekExpiredDraftBackup(sessionId: string): DraftBackupClaim | null {
  return freshestDraftBackup(sessionId);
}

const STORAGE_PREFIX = 'hyperneo_voice_transcript_outbox_v1.entry.';
const LANDED_PREFIX = `${STORAGE_PREFIX}landed.`;
const DRAFT_BACKUP_PREFIX = 'hyperneo_voice_transcript_outbox_v1.draft.';
const CLEAR_TOMBSTONE_PREFIX = 'hyperneo_voice_transcript_outbox_v1.clear.';
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FLUSH_DELAY_MS = 500;
const RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;

const mirror = new Map<string, PendingTranscript>();

function entryKey(id: string): string {
  return `${STORAGE_PREFIX}${id}`;
}

function collectFromStorage(): Map<string, PendingTranscript> {
  const out = new Map<string, PendingTranscript>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      try {
        const entry = JSON.parse(localStorage.getItem(key) ?? '') as PendingTranscript;
        if (entry && typeof entry.id === 'string' && typeof entry.sessionId === 'string') {
          out.set(entry.id, entry);
        }
      } catch {
        /* corrupt entry — skip */
      }
    }
  } catch {
    /* storage unavailable — mirror only */
  }
  return out;
}

function allEntries(): PendingTranscript[] {
  const merged = collectFromStorage();
  for (const [id, entry] of mirror) merged.set(id, entry);
  return [...merged.values()]
    .filter((e) => Date.now() - (e.createdAt ?? 0) < MAX_AGE_MS)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function writeEntry(entry: PendingTranscript): boolean {
  mirror.set(entry.id, entry);
  try {
    localStorage.setItem(entryKey(entry.id), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

function removeEntry(id: string): void {
  mirror.delete(id);
  try {
    localStorage.removeItem(entryKey(id));
  } catch {
    /* mirror already dropped it */
  }
}

function prune(): void {
  pruneExpired();
  const live = allEntries();
  if (live.length < MAX_ENTRIES) return;
  for (const entry of live.slice(0, live.length - (MAX_ENTRIES - 1))) {
    removeEntry(entry.id);
  }
}

function pruneExpired(): void {
  const now = Date.now();
  const stored = collectFromStorage();
  for (const [id, entry] of stored) {
    if (now - (entry.createdAt ?? 0) >= MAX_AGE_MS) removeEntry(id);
  }
  for (const [id, entry] of mirror) {
    if (now - (entry.createdAt ?? 0) >= MAX_AGE_MS) removeEntry(id);
  }
  try {
    const staleMarkers: Array<{ key: string; raw: string | null }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LANDED_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      const marker = parseLandedMarker(raw);
      if (!marker || now - marker.ts >= MAX_AGE_MS) staleMarkers.push({ key, raw });
    }
    for (const { key, raw } of staleMarkers) {
      let current: string | null = null;
      try {
        current = localStorage.getItem(key);
      } catch {
        current = null;
      }
      if (current !== raw) continue;
      localStorage.removeItem(key);
      const sessionId = key.slice(LANDED_PREFIX.length);
      const markedAt = landingMarkedAt.get(sessionId);
      if (markedAt === undefined || now - markedAt >= MAX_AGE_MS) {
        dropLocalLanding(sessionId);
      }
    }
  } catch {
    /* storage unavailable */
  }
  try {
    const staleBackupKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const isBackup = key?.startsWith(DRAFT_BACKUP_PREFIX);
      const isTombstone = key?.startsWith(CLEAR_TOMBSTONE_PREFIX);
      const isSuperseded = key?.startsWith(SUPERSEDED_PREFIX);
      if (!key || (!isBackup && !isTombstone && !isSuperseded)) continue;
      const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        ts?: number;
        beforeTs?: number;
      } | null;
      const stamp = parsed?.ts ?? parsed?.beforeTs ?? 0;
      if (parsed && now - stamp >= DRAFT_BACKUP_TTL_MS) staleBackupKeys.push(key);
    }
    for (const key of staleBackupKeys) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export function isPermanentAppendRefusal(error: unknown): boolean {
  return error instanceof Error && /Session not found/.test(error.message);
}

export function enqueueTranscript(sessionId: string, text: string, id?: string): boolean {
  prune();
  const durable = writeEntry({ id: id ?? generateUUID(), sessionId, text, createdAt: Date.now() });
  if (connectionState.value === 'connected') {
    setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
  }
  return durable;
}

export function getPendingTranscripts(): PendingTranscript[] {
  return allEntries().slice(0, MAX_ENTRIES);
}

export function removePendingTranscript(id: string): void {
  removeEntry(id);
}

export function clearPendingTranscripts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* mirror cleared below */
  }
  mirror.clear();
}

let flushInProgress = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = RETRY_DELAY_MS;

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelayMs = RETRY_DELAY_MS;
}

function scheduleFollowUpFlush(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushPendingTranscripts();
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
}

export async function flushPendingTranscripts(): Promise<void> {
  if (flushInProgress) return;
  const hub = connectionManager.getHubIfConnected();
  if (!hub) return;
  const pending = getPendingTranscripts();
  if (pending.length === 0) {
    pruneExpired();
    return;
  }

  flushInProgress = true;
  let delivered = 0;
  const deferredSessions = new Set<string>();
  try {
    for (const entry of pending) {
      if (!connectionManager.getHubIfConnected()) break;
      if (deferredSessions.has(entry.sessionId)) continue;
      try {
        await hub.request('session.appendVoiceDraft', {
          sessionId: entry.sessionId,
          text: entry.text,
          dedupId: entry.id,
        });
        removePendingTranscript(entry.id);
        delivered += 1;
        const alreadyAnnounced = getAnnouncedEntryIds(entry.sessionId).includes(entry.id);
        if (!alreadyAnnounced) {
          markVoiceTranscriptLanded(entry.sessionId, entry.text, entry.id);
        }
      } catch (error) {
        if (!connectionManager.getHubIfConnected()) break;
        if (isPermanentAppendRefusal(error)) removePendingTranscript(entry.id);
        else deferredSessions.add(entry.sessionId);
      }
    }
  } finally {
    flushInProgress = false;
    pruneExpired();
  }
  if (delivered > 0) retryDelayMs = RETRY_DELAY_MS;
  if (getPendingTranscripts().length > 0 && connectionManager.getHubIfConnected()) {
    scheduleFollowUpFlush();
  } else {
    clearRetryTimer();
  }
}

let cleanupAutoFlush: (() => void) | null = null;
let cleanupStorageListener: (() => void) | null = null;

function handleStorageEvent(event: StorageEvent): void {
  const key = event.key;
  if (!key) return;
  if (key.startsWith(STORAGE_PREFIX) && !key.startsWith(LANDED_PREFIX)) {
    if (event.newValue === null) {
      mirror.delete(key.slice(STORAGE_PREFIX.length));
    }
    if (connectionState.value === 'connected') {
      setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
    }
  } else if (key.startsWith(LANDED_PREFIX)) {
    const sessionId = key.slice(LANDED_PREFIX.length);
    const marker = parseLandedMarker(event.newValue);
    if (marker) {
      markVoiceTranscriptLandedLocal(
        sessionId,
        marker.text,
        true,
        marker.n,
        undefined,
        marker.ids,
        marker.entries
      );
    } else if (event.newValue === null && localStorage.getItem(key) === null) {
      dropLocalLanding(sessionId);
    }
  }
}

function hydrateLandedMarkers(): void {
  const now = Date.now();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(LANDED_PREFIX)) continue;
      const marker = parseLandedMarker(localStorage.getItem(key));
      if (marker && now - marker.ts < MAX_AGE_MS) {
        markVoiceTranscriptLandedLocal(
          key.slice(LANDED_PREFIX.length),
          marker.text,
          true,
          marker.n,
          undefined,
          marker.ids,
          marker.entries
        );
      }
    }
  } catch {
    /* storage unavailable */
  }
}

export function startVoiceTranscriptOutboxFlush(): void {
  if (cleanupAutoFlush) return;
  pruneExpired();
  hydrateLandedMarkers();
  window.addEventListener('storage', handleStorageEvent);
  cleanupStorageListener = () => window.removeEventListener('storage', handleStorageEvent);
  cleanupAutoFlush = effect(() => {
    if (connectionState.value === 'connected' && getPendingTranscripts().length > 0) {
      setTimeout(() => void flushPendingTranscripts(), FLUSH_DELAY_MS);
    }
  });
}

export function stopVoiceTranscriptOutboxFlush(): void {
  clearRetryTimer();
  if (cleanupAutoFlush) {
    cleanupAutoFlush();
    cleanupAutoFlush = null;
  }
  if (cleanupStorageListener) {
    cleanupStorageListener();
    cleanupStorageListener = null;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (cleanupAutoFlush) {
      cleanupAutoFlush();
      cleanupAutoFlush = null;
    }
    if (cleanupStorageListener) {
      cleanupStorageListener();
      cleanupStorageListener = null;
    }
    clearRetryTimer();
  });
}

export function resetVoiceTranscriptOutbox(): void {
  flushInProgress = false;
  clearRetryTimer();
  clearPendingTranscripts();
  voiceTranscriptLandedSignal.value = new Map();
  landingMarkedAt.clear();
  landingTexts.clear();
  landingIds.clear();
  landingEntries.clear();
  consumedMarkers.clear();
}
