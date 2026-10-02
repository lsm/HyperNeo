import { DRAFT_CHAR_LIMIT } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

type Draft = { sessionId: string; text: string; base: string | null };
export type NeoDraftReloadEntry = Draft & { id: string };
type Refusal = { kind: 'refused' };
const PREFIX = 'hyperneo_neo_draft_reload_v1.';
const MAX_ENTRIES = 20;

export function admitNeoReloadEdit(
  sessionId: string,
  text: string,
  base: string | null
): { value: Draft } | { reason: Refusal } {
  return sessionId.startsWith('neo:') &&
    sessionId.length > 4 &&
    sessionId.length <= 200 &&
    text.length <= DRAFT_CHAR_LIMIT &&
    (base === null || base.length <= DRAFT_CHAR_LIMIT)
    ? { value: { sessionId, text, base } }
    : { reason: { kind: 'refused' } };
}

export const planNeoReloadCapture = (superpipe({})('neo-reload-edit-capture') as PipelineAPI)
  .input(['sessionId', 'text', 'base', 'id'])
  .pipe(admitNeoReloadEdit, ['sessionId', 'text', 'base'], 'result:entry')
  .pipe(
    (draft: Draft, id: string): NeoDraftReloadEntry => ({ ...draft, id }),
    ['entry', 'id'],
    'entry'
  )
  .end('entry') as (
  sessionId: string,
  text: string,
  base: string | null,
  id: string
) => NeoDraftReloadEntry | Refusal;

function parseEntry(raw: string | null, sessionId: string): NeoDraftReloadEntry | null {
  if (!raw || raw.length > DRAFT_CHAR_LIMIT * 2 + 1024) return null;
  try {
    const entry: unknown = JSON.parse(raw);
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('sessionId' in entry) ||
      entry.sessionId !== sessionId ||
      !('text' in entry) ||
      typeof entry.text !== 'string' ||
      !('base' in entry) ||
      (entry.base !== null && typeof entry.base !== 'string') ||
      !('id' in entry) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      entry.id.length > 128
    )
      return null;
    const admitted = admitNeoReloadEdit(sessionId, entry.text, entry.base);
    return 'value' in admitted ? { ...admitted.value, id: entry.id } : null;
  } catch {
    return null;
  }
}

export function createNeoDraftReloadBuffer(
  getStorage: () => Storage = () => window.sessionStorage
) {
  const key = (sessionId: string) => `${PREFIX}${encodeURIComponent(sessionId)}`;
  function read(sessionId: string): NeoDraftReloadEntry | null {
    try {
      return parseEntry(getStorage().getItem(key(sessionId)), sessionId);
    } catch {
      return null;
    }
  }
  function remember(sessionId: string, text: string, base: string | undefined): boolean {
    try {
      const storage = getStorage();
      const target = key(sessionId);
      const raw = storage.getItem(target);
      const prior = parseEntry(raw, sessionId);
      if (raw !== null && !prior) return false;
      const planned = planNeoReloadCapture(
        sessionId,
        text,
        base ?? prior?.base ?? null,
        crypto.randomUUID()
      );
      if ('kind' in planned) return false;
      if (raw === null) {
        let count = 0;
        for (let i = 0; i < storage.length; i++) {
          if (storage.key(i)?.startsWith(PREFIX)) count += 1;
        }
        if (count >= MAX_ENTRIES) return false;
      }
      storage.setItem(target, JSON.stringify(planned));
      return true;
    } catch {
      return false;
    }
  }
  function forget(sessionId: string, expectedId: string): boolean {
    try {
      const storage = getStorage();
      const entry = parseEntry(storage.getItem(key(sessionId)), sessionId);
      if (!entry || entry.id !== expectedId) return false;
      storage.removeItem(key(sessionId));
      return true;
    } catch {
      return false;
    }
  }
  return { read, remember, forget };
}
