import type { Database } from '../../../storage/sqlite-compat.ts';
export function getNeoPackPreference(
  _db: Database,
  _pack: string,
  _scope: { kind: 'global' | 'repo' | 'project'; key: string },
  _key: string
): { value: unknown; setBy: string; setAt: number; scope: { kind: string; key: string } } | null {
  return null;
}
