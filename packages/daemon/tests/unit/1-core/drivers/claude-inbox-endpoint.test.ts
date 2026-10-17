import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readClaudeInboxEndpoint,
  requireClaudeInboxEndpoint,
  readClaudeSenderSession,
} from '../../../../src/lib/drivers/claude-inbox-endpoint';
import type { ClaudeSessionOwner } from '../../../../src/lib/drivers/claude-session-owner';

const live = { sessionId: '3b286924-739c-487d-82d2-c3e36fd5ed36', pid: 456, owner: 'cli' as const };
const registration = {
  sessionId: live.sessionId,
  pid: live.pid,
  procStart: 'Thu Oct 15 15:18:31 2026',
  entrypoint: 'cli',
  version: '2.1.295',
  messagingSocketPath: '/tmp/cc-socks/456.sock',
};
const desktop = {
  ...registration,
  entrypoint: 'claude-desktop',
  version: '2.1.299',
  peerProtocol: 1,
  peerFeatures: ['notify_idle', 'reply_across_default_dirs', 'artifact_yield'],
};

describe('requireClaudeInboxEndpoint', () => {
  test.each(['cli', 'sdk-ts'])(
    'returns only the registered endpoint for a matching %s owner',
    (entrypoint) => {
      expect(requireClaudeInboxEndpoint(live, { ...registration, entrypoint })).toEqual({
        value: {
          sessionId: live.sessionId,
          pid: 456,
          version: '2.1.295',
          socketPath: registration.messagingSocketPath,
        },
      });
    }
  );

  test.each([
    null,
    {},
    { ...registration, pid: 457 },
    { ...registration, sessionId: 'other' },
    { ...registration, procStart: undefined },
    { ...registration, entrypoint: 'claude-vscode' },
    { ...registration, version: 'future' },
    { ...registration, messagingSocketPath: undefined },
    { ...registration, messagingSocketPath: 'relative/456.sock' },
    { ...registration, messagingSocketPath: '/tmp/cc-socks/457.sock' },
    { ...registration, messagingSocketPath: '/tmp/cc-socks/456-agent.sock' },
  ])('fails closed for missing or conflicting endpoint evidence %j', (record) => {
    expect(requireClaudeInboxEndpoint(live, record)).toHaveProperty('reason.ok', false);
  });

  test('an inspected owner version does not imply a verified inbox protocol', () => {
    expect(requireClaudeInboxEndpoint(live, { ...registration, version: '2.1.299' })).toMatchObject(
      {
        reason: { reason: 'unsupported' },
      }
    );
  });

  test('verifies the Desktop 2.1.299 endpoint while preserving Desktop ownership', () => {
    expect(requireClaudeInboxEndpoint({ ...live, owner: 'desktop' }, desktop)).toEqual({
      value: {
        sessionId: live.sessionId,
        pid: live.pid,
        version: '2.1.299',
        socketPath: registration.messagingSocketPath,
      },
    });
  });

  test.each([
    { ...desktop, version: '2.1.295' },
    { ...desktop, version: 'future' },
    { ...desktop, peerProtocol: undefined },
    { ...desktop, peerProtocol: 2 },
    { ...desktop, peerFeatures: undefined },
    { ...desktop, peerFeatures: [] },
    { ...desktop, messagingSocketPath: '/tmp/cc-socks/457.sock' },
  ])('refuses unverified Desktop endpoint evidence %j', (record) => {
    expect(requireClaudeInboxEndpoint({ ...live, owner: 'desktop' }, record)).toHaveProperty(
      'reason.ok',
      false
    );
  });

  test('does not require the default socket directory or guess the registered basename', () => {
    expect(
      requireClaudeInboxEndpoint(live, {
        ...registration,
        messagingSocketPath: '/private/tmp/cc-socks/456-deadbeef.sock',
      })
    ).toHaveProperty('value.socketPath', '/private/tmp/cc-socks/456-deadbeef.sock');
  });
});

describe('readClaudeInboxEndpoint', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-inbox-registry-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('rechecks the registration belonging to the unique live CLI PID', async () => {
    await writeFile(join(dir, '456.json'), JSON.stringify(registration));
    expect(await readClaudeInboxEndpoint(live.sessionId, [live], dir)).toMatchObject({
      sessionId: live.sessionId,
      socketPath: registration.messagingSocketPath,
    });
    await writeFile(
      join(dir, '456.json'),
      JSON.stringify({ ...registration, entrypoint: 'claude-desktop' })
    );
    expect(await readClaudeInboxEndpoint(live.sessionId, [live], dir)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  test.each(['desktop', 'unknown'] as ClaudeSessionOwner[])(
    'rejects a live %s owner even with a stale CLI registry',
    async (owner) => {
      await writeFile(join(dir, '456.json'), JSON.stringify(registration));
      expect(
        await readClaudeInboxEndpoint(live.sessionId, [{ ...live, owner }], dir)
      ).toMatchObject({
        ok: false,
        reason: 'unreachable',
      });
    }
  );

  test('reads a Desktop endpoint afresh instead of rejecting its owner before validation', async () => {
    await writeFile(join(dir, '456.json'), JSON.stringify(desktop));
    const sessions = [{ ...live, owner: 'desktop' as const }];
    expect(await readClaudeInboxEndpoint(live.sessionId, sessions, dir)).toMatchObject({
      version: '2.1.299',
      socketPath: desktop.messagingSocketPath,
    });
    await writeFile(join(dir, '456.json'), JSON.stringify({ ...desktop, peerProtocol: 2 }));
    expect(await readClaudeInboxEndpoint(live.sessionId, sessions, dir)).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
  });

  test('refuses ambiguous live ownership instead of selecting a socket', async () => {
    await writeFile(join(dir, '456.json'), JSON.stringify(registration));
    expect(await readClaudeInboxEndpoint(live.sessionId, [live, live], dir)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  test('missing, malformed and changed registrations never infer a socket or restore', async () => {
    for (const content of [undefined, '{broken', JSON.stringify({ ...registration, pid: 457 })]) {
      if (content !== undefined) await writeFile(join(dir, '456.json'), content);
      expect(await readClaudeInboxEndpoint(live.sessionId, [live], dir)).toMatchObject({
        ok: false,
        reason: 'unreachable',
      });
    }
    expect(await readClaudeInboxEndpoint(live.sessionId, [], dir)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });
});

describe('readClaudeSenderSession', () => {
  test('names a reply sender from its socket registration, and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-sender-'));
    try {
      const sessionId = '6d9e55f8-05b0-4445-a5f8-4f8b123fb043';
      await writeFile(
        join(dir, '4321.json'),
        JSON.stringify({ sessionId, pid: 4321, messagingSocketPath: '/tmp/cc-socks/4321.sock' })
      );
      expect(await readClaudeSenderSession('uds:/tmp/cc-socks/4321.sock', dir)).toBe(sessionId);
      expect(await readClaudeSenderSession('uds:/tmp/cc-socks/other/4321.sock', dir)).toBeNull();
      expect(await readClaudeSenderSession('uds:/tmp/cc-socks/9999.sock', dir)).toBeNull();
      expect(await readClaudeSenderSession('bridge:abc', dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
