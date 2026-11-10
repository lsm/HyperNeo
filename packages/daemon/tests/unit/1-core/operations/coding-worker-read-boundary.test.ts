import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { resolveNeoTodoDraft } from '../../../../src/lib/neo/todo-operations.ts';

const source = (path: string) =>
  readFileSync(new URL(`../../../../src/lib/${path}`, import.meta.url), 'utf8');
const ref = { adapter: 'hyperneo' as const, id: 'synthetic-worker', daemon: 'synthetic-owner' };
const draft = {
  title: 'Synthetic work',
  check: { pack: 'core', kind: 'evidence', params: {} },
  instruction: null,
  named: null,
  target: { verb: 'send' as const, ref },
  start: false,
  priority: 'normal' as const,
};

describe('worker read boundary', () => {
  test('passes recorded worker facts to admission without interpreting them', async () => {
    const workerRemotes = ['opaque:workspace-identity'];
    const read = vi.fn(async () => ({ value: ref, workerRemotes }));
    const resolved = await resolveNeoTodoDraft(draft, read);
    expect(resolved).toEqual({ value: { ...draft, workerRemotes } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ref);
  });

  test('preserves the worker reader refusal', async () => {
    const refused = { reason: { ok: false as const, reason: 'worker unavailable' } };
    const read = vi.fn(async () => refused);
    expect(await resolveNeoTodoDraft(draft, read)).toEqual(refused);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(ref);
  });

  test('coding owns worker Git effects while the shared identity helper stays in core', () => {
    const core = source('neo/todo-operations.ts');
    expect(core).not.toContain('runGhJson');
    expect(core).not.toContain('readWorkspaceIdentity');
    expect(source('neo/project-mirror.ts')).toContain('export function neoRepositoryIdentity');
    expect(source('neo/packs/coding/worker-read.ts')).toContain('runGhJson');
  });
});
