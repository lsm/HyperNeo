import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workStartPreparation as preparation } from '../../../../src/lib/drivers/start-preparation';
import { workResultSchema, WorkSummarySchema } from '../../../../src/lib/drivers/types';
import { prepareCodingExecution } from '../../../../src/lib/neo/packs/coding/prepare-execution';

const request = { pack: 'coding', parameters: { target: 'dev', prerequisiteCommits: [] } };
const location = { directory: '/repo', destination: '/isolated/repo' };

describe('workStartPreparation', () => {
  test('runs a registered coding stage and returns cleanup ownership without starting work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'registered-preparation-'));
    const source = join(root, 'source');
    const destination = join(root, 'worker');
    const run = async (command: readonly string[], directory: string) => {
      const result = spawnSync(command[0], command.slice(1), { cwd: directory, encoding: 'utf8' });
      return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    try {
      expect((await run(['git', 'init', '--initial-branch=dev', source], root)).code).toBe(0);
      await run(['git', 'config', 'user.name', 'Synthetic'], source);
      await run(['git', 'config', 'user.email', 'synthetic@example.invalid'], source);
      writeFileSync(join(source, 'AGENTS.md'), '## Verify\nRun the synthetic proof.\n');
      await run(['git', 'add', '.'], source);
      expect((await run(['git', 'commit', '-m', 'initial'], source)).code).toBe(0);
      await run(['git', 'remote', 'add', 'origin', source], source);
      const prepared = await preparation.prepare(
        request,
        { directory: source, destination },
        [{ id: 'coding', prepareExecution: prepareCodingExecution }],
        { run }
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error(prepared.detail);
      expect(prepared.value.directory).toBe(destination);
      expect(statSync(join(destination, '.git')).isDirectory()).toBe(true);
      expect((await run(['git', 'rev-parse', 'HEAD'], destination)).stdout).toBe(
        (await run(['git', 'rev-parse', 'HEAD'], source)).stdout
      );
      await prepared.value.release();
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(join(source, 'AGENTS.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
