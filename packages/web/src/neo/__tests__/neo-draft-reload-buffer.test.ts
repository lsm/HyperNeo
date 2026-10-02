import { DRAFT_CHAR_LIMIT } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import {
  admitNeoReloadEdit,
  createNeoDraftReloadBuffer,
  planNeoReloadCapture,
} from '../neo-draft-reload-buffer.ts';

const root = 'neo:root';
const holder = 'neo:holder';
const key = (id: string) => `hyperneo_neo_draft_reload_v1.${encodeURIComponent(id)}`;
function storage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
    removeItem: (name: string) => {
      values.delete(name);
    },
    clear: () => values.clear(),
  } satisfies Storage;
}

describe('admitNeoReloadEdit', () => {
  it.each(['', 'session:ordinary', 'neo:', `neo:${'a'.repeat(197)}`])(
    'refuses an unopened, non-Neo, or oversized owner: %s',
    (owner) => {
      expect(admitNeoReloadEdit(owner, 'text', null)).toEqual({ reason: { kind: 'refused' } });
    }
  );
  it.each([
    { text: 'a'.repeat(DRAFT_CHAR_LIMIT + 1), base: null },
    { text: 'a', base: 'b'.repeat(DRAFT_CHAR_LIMIT + 1) },
  ])('refuses content beyond the existing draft limit', ({ text, base }) => {
    expect(admitNeoReloadEdit(root, text, base)).toHaveProperty('reason.kind', 'refused');
  });
  it.each(['', '  ', '  **Markdown**\nexact source  ', 'a'.repeat(DRAFT_CHAR_LIMIT)])(
    'preserves admitted exact text length=$length',
    (text) => {
      expect(admitNeoReloadEdit(root, text, 'base')).toEqual({
        value: { sessionId: root, text, base: 'base' },
      });
    }
  );
});

describe('planNeoReloadCapture', () => {
  it('records the supplied version without changing base or text', () => {
    expect(planNeoReloadCapture(root, ' exact ', null, 'version-one')).toEqual({
      sessionId: root,
      text: ' exact ',
      base: null,
      id: 'version-one',
    });
  });
  it('halts before version construction on an invalid owner', () => {
    expect(planNeoReloadCapture('', 'text', null, 'version-one')).toEqual({ kind: 'refused' });
  });
});

describe('createNeoDraftReloadBuffer', () => {
  it('lets a fresh buffer instance read the exact stored edit without replaying it', () => {
    const saved = storage();
    const first = createNeoDraftReloadBuffer(() => saved);
    expect(first.remember(root, '  draft\n  ', 'server base')).toBe(true);
    const entry = first.read(root);
    expect(entry).toMatchObject({ sessionId: root, text: '  draft\n  ', base: 'server base' });
    expect(createNeoDraftReloadBuffer(() => saved).read(root)).toEqual(entry);
  });
  it('keeps root and holder identities independent', () => {
    const saved = storage();
    const buffer = createNeoDraftReloadBuffer(() => saved);
    expect(buffer.remember(root, 'root edit', 'root base')).toBe(true);
    expect(buffer.remember(holder, 'holder edit', 'holder base')).toBe(true);
    expect(buffer.read(root)).toMatchObject({ text: 'root edit', base: 'root base' });
    expect(buffer.read(holder)).toMatchObject({ text: 'holder edit', base: 'holder base' });
    expect(buffer.forget(holder, buffer.read(root)!.id)).toBe(false);
  });
  it.each([false, true])(
    'refuses an older receipt even when newer text matches: same=%s',
    (same) => {
      const saved = storage();
      const buffer = createNeoDraftReloadBuffer(() => saved);
      buffer.remember(root, 'submitted', 'base');
      const submitted = buffer.read(root)!;
      buffer.remember(root, same ? 'submitted' : 'new edit', 'base');
      const newer = buffer.read(root)!;
      expect(newer.id).not.toBe(submitted.id);
      expect(buffer.forget(root, submitted.id)).toBe(false);
      expect(buffer.read(root)).toEqual(newer);
      expect(buffer.forget(root, newer.id)).toBe(true);
      expect(buffer.read(root)).toBeNull();
    }
  );
  it('captures a manual empty edit rather than deleting unrelated data', () => {
    const saved = storage();
    saved.setItem('unowned', 'preserved');
    const buffer = createNeoDraftReloadBuffer(() => saved);
    buffer.remember(root, 'text', 'base');
    expect(buffer.remember(root, '', undefined)).toBe(true);
    expect(buffer.read(root)).toMatchObject({ text: '', base: 'base' });
    expect(saved.getItem('unowned')).toBe('preserved');
  });
  it('updates the confirmed base only from the caller-provided value', () => {
    const saved = storage();
    const buffer = createNeoDraftReloadBuffer(() => saved);
    buffer.remember(root, 'first edit', undefined);
    expect(buffer.read(root)?.base).toBeNull();
    buffer.remember(root, 'second edit', 'confirmed first edit');
    expect(buffer.read(root)?.base).toBe('confirmed first edit');
  });
  it('refuses the twenty-first owner without evicting any buffered edit', () => {
    const saved = storage();
    const buffer = createNeoDraftReloadBuffer(() => saved);
    for (let i = 0; i < 20; i++) expect(buffer.remember(`neo:${i}`, `edit ${i}`, '')).toBe(true);
    expect(buffer.remember('neo:extra', 'extra edit', '')).toBe(false);
    expect(saved.length).toBe(20);
    for (let i = 0; i < 20; i++) expect(buffer.read(`neo:${i}`)?.text).toBe(`edit ${i}`);
    expect(buffer.remember('neo:0', 'new zero', '')).toBe(true);
  });
  it.each([
    '{',
    'null',
    '[]',
    JSON.stringify({ sessionId: root, text: 1, base: '', id: 'one' }),
    JSON.stringify({ sessionId: holder, text: 'other owner', base: '', id: 'one' }),
    JSON.stringify({ sessionId: root, text: 'text', base: 1, id: 'one' }),
    JSON.stringify({ sessionId: root, text: 'text', base: '', id: '' }),
    'x'.repeat(DRAFT_CHAR_LIMIT * 2 + 1025),
  ])('does not overwrite or retire malformed stored data', (raw) => {
    const saved = storage();
    saved.setItem(key(root), raw);
    const buffer = createNeoDraftReloadBuffer(() => saved);
    expect(buffer.read(root)).toBeNull();
    expect(buffer.remember(root, 'new edit', '')).toBe(false);
    expect(buffer.forget(root, 'one')).toBe(false);
    expect(saved.getItem(key(root))).toBe(raw);
  });
  it('reports unavailable storage without claiming capture or retirement', () => {
    const buffer = createNeoDraftReloadBuffer(() => {
      throw new Error('Blocked');
    });
    expect(buffer.remember(root, 'edit', '')).toBe(false);
    expect(buffer.read(root)).toBeNull();
    expect(buffer.forget(root, 'one')).toBe(false);
  });
  it('keeps the existing entry when a storage write or retirement fails', () => {
    const saved = storage();
    const buffer = createNeoDraftReloadBuffer(() => saved);
    buffer.remember(root, 'old edit', 'base');
    const entry = buffer.read(root)!;
    saved.setItem = () => {
      throw new Error('Quota');
    };
    saved.removeItem = () => {
      throw new Error('Blocked');
    };
    expect(buffer.remember(root, 'new edit', 'base')).toBe(false);
    expect(buffer.forget(root, entry.id)).toBe(false);
    expect(buffer.read(root)).toEqual(entry);
  });
});
