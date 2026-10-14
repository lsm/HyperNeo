import { describe, expect, test } from 'bun:test';
import { workStartPreparation as preparation } from '../../../../src/lib/drivers/start-preparation';
import { workResultSchema, WorkSummarySchema } from '../../../../src/lib/drivers/types';
import { prepareCodingExecution } from '../../../../src/lib/neo/packs/coding/prepare-execution';

const request = { pack: 'coding', parameters: { target: 'dev', prerequisiteCommits: [] } };
const location = { directory: '/repo', destination: '/isolated/repo' };

describe('workStartPreparation', () => {
  test('runs a registered coding stage and returns cleanup ownership without starting work', async () => {
    const calls: unknown[] = [];
    const commit = 'a'.repeat(40);
    const prepared = await preparation.prepare(
      request,
      location,
      [{ id: 'coding', prepareExecution: prepareCodingExecution }],
      {
        run: async (command, directory) => {
          calls.push({ command, directory });
          return { code: 0, stdout: command[1] === 'rev-parse' ? commit : '', stderr: '' };
        },
      }
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.detail);
    expect(prepared.value.directory).toBe(location.destination);
    expect(calls).toEqual([
      {
        command: ['git', 'fetch', '--no-tags', 'origin', '+refs/heads/dev:refs/remotes/origin/dev'],
        directory: '/repo',
      },
      {
        command: ['git', 'rev-parse', '--verify', 'refs/remotes/origin/dev^{commit}'],
        directory: '/repo',
      },
      {
        command: ['git', 'worktree', 'add', '--detach', '/isolated/repo', commit],
        directory: '/repo',
      },
    ]);
    await prepared.value.release();
    expect(calls.at(-1)).toEqual({
      command: ['git', 'worktree', 'remove', '--force', '/isolated/repo'],
      directory: '/repo',
    });
  });

  test.each(['missing', 'no-stage', 'duplicate'])(
    'refuses %s registration before preparation effects',
    async (kind) => {
      const calls: string[] = [];
      const entry = {
        id: 'coding',
        prepareExecution: async () => {
          calls.push('stage');
          return {
            ok: true as const,
            value: { directory: '/isolated/repo', release: async () => {} },
          };
        },
      };
      const registrations =
        kind === 'missing' ? [] : kind === 'no-stage' ? [{ id: 'coding' }] : [entry, entry];
      expect(
        await preparation.prepare(request, location, registrations, {
          run: async () => {
            calls.push('command');
            return { code: 0, stdout: '', stderr: '' };
          },
        })
      ).toMatchObject({ ok: false, reason: 'unsupported_preparation' });
      expect(calls).toEqual([]);
    }
  );

  test('keeps pack failure detail with a work-result-compatible refusal', async () => {
    const commands: string[][] = [];
    const refused = await preparation.prepare(
      request,
      location,
      [{ id: 'coding', prepareExecution: prepareCodingExecution }],
      {
        run: async (command) => {
          commands.push([...command]);
          return { code: 1, stdout: '', stderr: 'offline' };
        },
      }
    );
    expect(refused).toEqual({
      ok: false,
      reason: 'preparation_failed',
      detail: 'coding: fetch_failed: offline',
    });
    expect(workResultSchema(WorkSummarySchema).parse(refused)).toEqual(refused);
    expect(commands.map((command) => command[1])).toEqual(['fetch']);
  });

  test('forwards opaque custom parameters without adding coding decisions', async () => {
    const received: unknown[] = [];
    let released = false;
    const result = await preparation.prepare(
      { pack: 'legal', parameters: { matter: '123', signed: true } },
      location,
      [
        {
          id: 'legal',
          prepareExecution: async (input) => {
            received.push(input);
            return {
              ok: true,
              value: {
                directory: location.destination,
                release: async () => {
                  released = true;
                },
              },
            };
          },
        },
      ],
      {
        run: async () => {
          throw new Error('Unexpected command');
        },
      }
    );
    expect(received).toEqual([{ ...location, parameters: { matter: '123', signed: true } }]);
    expect(released).toBe(false);
    if (!result.ok) throw new Error(result.detail);
    await result.value.release();
    expect(released).toBe(true);
  });

  test('omitted preparation preserves ordinary starts; requested preparation needs explicit support', () => {
    expect(preparation.admit(undefined, false)).toEqual({ value: undefined });
    expect(preparation.admit(request, true)).toEqual({ value: request });
    const rejected = preparation.admit(request, false);
    expect(rejected).toMatchObject({ reason: { ok: false, reason: 'unsupported_preparation' } });
    if ('reason' in rejected)
      expect(workResultSchema(WorkSummarySchema).parse(rejected.reason)).toEqual(rejected.reason);
    expect(preparation.schema.safeParse({ pack: '../coding', parameters: {} }).success).toBe(false);
    expect(
      preparation.schema.safeParse({ pack: 'coding', parameters: { callback: () => {} } }).success
    ).toBe(false);
  });
});
