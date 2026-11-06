import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCopilotSessions } from '../../../../src/lib/drivers/copilot-discovery';
import {
  copilotFolder,
  copilotSession,
  prepareCopilotFixture,
} from '../../../helpers/copilot-fixture';

const runs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});
function fixture() {
  const run = mkdtempSync(join(tmpdir(), 'copilot-pin-'));
  runs.push(run);
  return prepareCopilotFixture(run);
}

describe('Copilot discovery boundary', () => {
  test('lists SDK metadata with the same titles and recovered project folders', async () => {
    const { home, bin } = fixture();
    const updatedAt = new Date().toISOString();
    const sdk = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
    const command = join(bin, 'copilot');
    writeFileSync(
      command,
      `#!/usr/bin/env bun\nprocess.argv.push('--production-version'); await import(${JSON.stringify(sdk)});\n`,
      { mode: 0o700 }
    );
    writeFileSync(
      join(home, 'copilot-list.json'),
      JSON.stringify([
        {
          sessionId: copilotSession,
          cwd: home,
          title: '[User]: Synthetic\n sum task',
          updatedAt,
        },
        {
          sessionId: '22222222-2222-4222-8222-222222222222',
          cwd: '/synthetic/other-project',
          title: 'Other task',
          updatedAt,
        },
      ])
    );
    const sessions = await listCopilotSessions(command, home, 1500);
    expect(sessions.map((session) => [session.sessionId, session.cwd, session.title])).toEqual([
      [copilotSession, copilotFolder, 'Synthetic sum task'],
      ['22222222-2222-4222-8222-222222222222', '/synthetic/other-project', 'Other task'],
    ]);
    const calls = readFileSync(join(home, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.method)).toContain('session.list');
    expect(
      calls.some((call) =>
        ['session.create', 'session.resume', 'session.send', 'initialize', 'session/list'].includes(
          call.method
        )
      )
    ).toBe(false);
    for (const pid of new Set<number>(calls.map((call) => call.pid)))
      expect(() => process.kill(pid, 0)).toThrow();
  });

  test('reports listing failure without inventing a successful empty result', async () => {
    const { home, bin } = fixture();
    writeFileSync(join(home, 'copilot-list-failure'), 'fail');
    await expect(listCopilotSessions(join(bin, 'copilot'), home, 1500)).rejects.toThrow(
      'Synthetic listing failure'
    );
  });

  test('bounds a stalled listing and closes its own SDK process', async () => {
    const { home, bin } = fixture();
    const sdk = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
    writeFileSync(
      join(bin, 'copilot'),
      `#!/usr/bin/env bun\nprocess.argv.push('--production-version', '--held-list'); await import(${JSON.stringify(sdk)});\n`,
      { mode: 0o700 }
    );
    await expect(listCopilotSessions(join(bin, 'copilot'), home, 1500)).rejects.toThrow(
      'Listing sessions timed out'
    );
    const calls = readFileSync(join(home, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.method)).toContain('session.list');
    for (const pid of new Set<number>(calls.map((call) => call.pid)))
      expect(() => process.kill(pid, 0)).toThrow();
  });

  test('refuses an incompatible SDK protocol and closes its process', async () => {
    const { home, bin } = fixture();
    const sdk = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
    writeFileSync(
      join(bin, 'copilot'),
      `#!/usr/bin/env bun\nprocess.argv.push('--production-version', '--bad-protocol'); await import(${JSON.stringify(sdk)});\n`,
      { mode: 0o700 }
    );
    await expect(listCopilotSessions(join(bin, 'copilot'), home, 1500)).rejects.toThrow(
      /protocol/i
    );
  });
});
