import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLiveClaudeSessions } from '../../../../src/lib/drivers/claude-desktop-adapter';
import {
  claudeSessionOwner,
  readClaudeSessionOwner,
  requireClaudeCliOwner,
  requireClaudePeerOwner,
} from '../../../../src/lib/drivers/claude-session-owner';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';

const live = { sessionId: 'session-a', pid: 123 };
const registration = {
  ...live,
  procStart: 'Thu Oct 15 15:18:31 2026',
  entrypoint: 'cli',
  version: '2.1.295',
};

describe('claudeSessionOwner', () => {
  test.each(['2.1.295', '2.1.299', '2.1.302', '2.2.0'])(
    'recognizes matched CLI and SDK registrations on any engine version %s',
    (version) => {
      for (const entrypoint of ['cli', 'sdk-ts']) {
        expect(claudeSessionOwner(live, { ...registration, version, entrypoint })).toBe('cli');
      }
    }
  );

  test('Desktop ownership takes precedence even on a newer version', () => {
    expect(
      claudeSessionOwner(live, {
        ...registration,
        entrypoint: 'claude-desktop',
        version: 'future',
        hostSessionId: 'local_old-context',
      })
    ).toBe('desktop');
  });

  test.each([
    null,
    {},
    { ...registration, pid: 124 },
    { ...registration, sessionId: 'session-b' },
    { ...registration, procStart: undefined },
    { ...registration, entrypoint: undefined },
    { ...registration, entrypoint: 'claude-vscode' },
    { ...registration, entrypoint: 'future-owner' },
  ])('does not infer an owner from incomplete or conflicting evidence %j', (record) => {
    expect(claudeSessionOwner(live, record)).toBe('unknown');
  });

  test('a session ID without its live PID is insufficient', () => {
    expect(claudeSessionOwner({ sessionId: live.sessionId }, registration)).toBe('unknown');
  });
});

describe('requireClaudeCliOwner', () => {
  test('admits exactly one confirmed live CLI owner', () => {
    expect(requireClaudeCliOwner(live.sessionId, [{ ...live, owner: 'cli' }])).toEqual({
      value: { ...live, owner: 'cli' },
    });
  });

  test('Desktop ownership rejects CLI even with conflicting CLI evidence', () => {
    expect(
      requireClaudeCliOwner(live.sessionId, [
        { ...live, owner: 'cli' },
        { ...live, pid: 456, owner: 'desktop' },
      ])
    ).toMatchObject({
      reason: { reason: 'unsupported', detail: expect.stringContaining('Desktop') },
    });
  });

  test.each(
    [
      [],
      [{ ...live, owner: 'unknown' as const }],
      [live],
      [{ sessionId: live.sessionId, owner: 'cli' as const }],
      [{ ...live, sessionId: 'different', owner: 'cli' as const }],
      [
        { ...live, owner: 'cli' as const },
        { ...live, owner: 'cli' as const },
      ],
    ].map((sessions) => ({ sessions }))
  )('rejects unavailable, unknown or ambiguous ownership %j', ({ sessions }) => {
    expect(requireClaudeCliOwner(live.sessionId, sessions)).toMatchObject({
      reason: { reason: 'unreachable', detail: expect.stringContaining('will not resume') },
    });
  });
});

describe('requireClaudePeerOwner', () => {
  test.each(['cli', 'desktop'] as const)(
    'retains the unique %s owner for endpoint validation',
    (owner) => {
      expect(requireClaudePeerOwner(live.sessionId, [{ ...live, owner }])).toEqual({
        value: { ...live, owner },
      });
      expect(requireClaudePeerOwner(live.sessionId, [{ ...live, pid: 0, owner }])).toHaveProperty(
        'reason.reason',
        'unreachable'
      );
    }
  );

  test('refuses conflicting owners instead of choosing a known socket', () => {
    expect(
      requireClaudePeerOwner(live.sessionId, [
        { ...live, owner: 'cli' },
        { ...live, pid: 456, owner: 'desktop' },
      ])
    ).toHaveProperty('reason.reason', 'unreachable');
  });
});

describe('Claude session ownership discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-owner-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('reads only the registration named by the live PID', async () => {
    writeFileSync(join(dir, '123.json'), JSON.stringify(registration));
    writeFileSync(join(dir, '456.json'), JSON.stringify({ ...registration, pid: 456 }));
    expect(await readClaudeSessionOwner(live, dir)).toBe('cli');
    expect(await readClaudeSessionOwner({ ...live, pid: 789 }, dir)).toBe('unknown');
  });

  test('fails closed on malformed or unreadable records', async () => {
    writeFileSync(join(dir, '123.json'), '{broken');
    expect(await readClaudeSessionOwner(live, dir)).toBe('unknown');
    rmSync(join(dir, '123.json'));
    mkdirSync(join(dir, '123.json'));
    expect(await readClaudeSessionOwner(live, dir)).toBe('unknown');
    expect(await readClaudeSessionOwner({ ...live, pid: -1 }, dir)).toBe('unknown');
  });

  test('live discovery joins ownership per session instead of per app', async () => {
    writeFileSync(join(dir, '123.json'), JSON.stringify(registration));
    writeFileSync(
      join(dir, '456.json'),
      JSON.stringify({
        ...registration,
        pid: 456,
        sessionId: 'desktop',
        entrypoint: 'claude-desktop',
      })
    );
    const sessions = [
      { ...live, status: 'busy' },
      { pid: 456, sessionId: 'desktop', status: 'idle' },
      { pid: 789, sessionId: 'unknown', status: 'waiting' },
    ];
    const spawn: SpawnFn = () => ({
      stdout: new Response(JSON.stringify(sessions)).body,
      stderr: null,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    });
    expect(await readLiveClaudeSessions(spawn, dir)).toEqual([
      { ...sessions[0], owner: 'cli' },
      { ...sessions[1], owner: 'desktop' },
      { ...sessions[2], owner: 'unknown' },
    ]);
  });
});
