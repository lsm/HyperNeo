import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readClaudeCliStatus,
  requireClaudeCliStatus,
} from '../../../../src/lib/drivers/claude-cli-status';

const sessionId = randomUUID();
const ref = { adapter: 'claude-code', id: sessionId };
const live = { sessionId, pid: 456, owner: 'cli' as const, name: 'worker', status: 'busy' };
const receipt = { executionId: sessionId, inputId: randomUUID() };

describe('requireClaudeCliStatus', () => {
  test.each([
    ['busy', 'running'],
    ['waiting', 'needs_you'],
    ['idle', 'done'],
    ['done', 'done'],
    ['completed', 'done'],
  ])('maps the known native status %s to %s', (status, expected) => {
    expect(requireClaudeCliStatus(ref, [{ ...live, status }])).toMatchObject({
      value: { status: expected },
    });
  });
  test.each(['future-status', '', 'stopping'])(
    'never turns an unknown status %s into done',
    (status) => {
      expect(requireClaudeCliStatus(ref, [{ ...live, status }])).toMatchObject({
        reason: { reason: 'unreachable' },
      });
    }
  );
  test('reuses owner admission and does not require a unique display name', () => {
    expect(
      requireClaudeCliStatus(ref, [live, { ...live, sessionId: randomUUID(), pid: 789 }])
    ).toHaveProperty('value.status', 'running');
    expect(requireClaudeCliStatus(ref, [live, live])).toHaveProperty(
      'reason.reason',
      'unreachable'
    );
    expect(requireClaudeCliStatus(ref, [{ ...live, owner: 'desktop' }])).toHaveProperty(
      'reason.reason',
      'unsupported'
    );
  });
});

describe('live Claude CLI status evidence', () => {
  let dir: string;
  let deps: Parameters<typeof readClaudeCliStatus>[3];
  const inputAt = '2026-10-16T21:00:00.000Z';
  const replyAt = '2026-10-16T21:00:01.000Z';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-cli-status-'));
    await mkdir(join(dir, '-focus-repo'));
    await writeFile(
      join(dir, '-focus-repo', `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          uuid: receipt.inputId,
          timestamp: inputAt,
          message: { content: 'question' },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: replyAt,
          message: { content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn' },
        }),
      ].join('\n')
    );
    deps = {
      machine: 'test-machine',
      projectsDir: dir,
      liveSessions: async () => [live],
      folder: async () => '/focus/repo',
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('returns native status with scoped transcript evidence rather than a Desktop identity', async () => {
    const result = await readClaudeCliStatus(ref, 0, receipt, deps);
    expect(result).toMatchObject({
      ok: true,
      value: {
        ref,
        title: 'worker',
        status: 'running',
        place: { folder: '/focus/repo', machine: 'test-machine' },
        lastActivityAt: Date.parse(replyAt),
        lastReply: 'answer',
        lastReplyAt: Date.parse(replyAt),
        turnEnds: [{ id: expect.any(String), at: Date.parse(replyAt), message: 'answer' }],
        inputEvidence: {
          receipt,
          state: 'observed',
          exchange: [
            { role: 'user', text: 'question' },
            { role: 'agent', text: 'answer' },
          ],
        },
      },
    });
    if (!result.ok) throw new Error('Expected CLI observation');
    expect(result.value).not.toHaveProperty('link');
    expect(result.value.exchange).toHaveLength(2);
  });

  test.each([
    { ...receipt, executionId: randomUUID() },
    { ...receipt, inputId: randomUUID() },
  ])('does not attribute history to a foreign or absent receipt %j', async (foreign) => {
    expect(await readClaudeCliStatus(ref, undefined, foreign, deps)).toMatchObject({
      value: { lastReply: 'answer', inputEvidence: { receipt: foreign, state: 'unavailable' } },
    });
  });

  test('missing history remains unavailable without inventing an activity timestamp', async () => {
    deps.folder = async () => null;
    expect(await readClaudeCliStatus(ref, undefined, receipt, deps)).toMatchObject({
      value: {
        status: 'running',
        lastActivityAt: 0,
        inputEvidence: { receipt, state: 'unavailable' },
      },
    });
  });

  test('a recognized input without a turn end is pending rather than an attributed answer', async () => {
    await writeFile(
      join(dir, '-focus-repo', `${sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: receipt.inputId,
        timestamp: inputAt,
        message: { content: 'question' },
      })
    );
    expect(await readClaudeCliStatus(ref, undefined, receipt, deps)).toMatchObject({
      value: {
        status: 'running',
        inputEvidence: { receipt, state: 'pending' },
      },
    });
  });

  test.each(['desktop', 'unknown', 'absent'])(
    'does not read a transcript or resume a session when ownership is %s',
    async (owner) => {
      deps.liveSessions = async () =>
        owner === 'absent' ? [] : [{ ...live, owner: owner === 'desktop' ? 'desktop' : 'unknown' }];
      deps.folder = async () => {
        throw new Error('must not read');
      };
      expect(await readClaudeCliStatus(ref, undefined, receipt, deps)).toMatchObject({
        ok: false,
        reason: owner === 'desktop' ? 'unsupported' : 'unreachable',
      });
    }
  );
});
