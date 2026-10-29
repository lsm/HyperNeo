import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeTranscriptState,
  describeClaudeSession,
} from '../../../../src/lib/drivers/claude-desktop-adapter';
import { readClaudeCliStatus } from '../../../../src/lib/drivers/claude-cli-status';
import { WorkDetailSchema } from '../../../../src/lib/drivers/types';

const fixture = await readFile(
  new URL('./fixtures/claude-observed-identity.jsonl', import.meta.url),
  'utf8'
);
const lines = fixture.trim().split('\n');
const observed = { model: 'claude-opus-5-5', effort: 'medium' };
const assistant = (extra: object) =>
  JSON.stringify({ type: 'assistant', uuid: 'next', timestamp: '2026-10-28T16:29:00Z', ...extra });

describe('Claude transcript runtime identity', () => {
  test('reads redacted Opus 5.5 outer metadata despite misleading PR and tool bodies', () => {
    const state = claudeTranscriptState(lines, Date.parse('2026-10-29'));
    expect(state).toMatchObject(observed);
    expect(state.identityObservation).toEqual({
      source: 'assistant-transcript',
      messageId: 'observed',
      at: Date.parse('2026-10-28T16:28:30Z'),
    });
  });
  test('updates model and prefers the per-turn override', () => {
    expect(
      claudeTranscriptState([
        ...lines,
        assistant({
          effort: 'medium',
          perTurnEffort: 'high',
          message: { model: 'claude-sonnet-5', content: [] },
        }),
      ])
    ).toMatchObject({ model: 'claude-sonnet-5', effort: 'high' });
  });
  test.each([
    { message: { model: 'claude-sonnet-5', content: [] } },
    { perTurnEffort: 'high', message: { content: [] } },
    { effort: 'medium', perTurnEffort: null, message: { content: [] } },
    { effort: '', message: { model: 42, content: [] } },
  ])('never combines a partial new observation with older fields: %j', (entry) => {
    const state = claudeTranscriptState([...lines, assistant(entry)]);
    expect(state.model).toBe(
      typeof entry.message.model === 'string' ? entry.message.model : undefined
    );
    expect(state.effort).toBe(entry.perTurnEffort === 'high' ? 'high' : undefined);
  });
  test('does not derive identity from user or tool records or body text', () => {
    const state = claudeTranscriptState(
      lines.filter((line) => JSON.parse(line).uuid !== 'observed')
    );
    expect(state.model).toBeUndefined();
    expect(state.effort).toBeUndefined();
  });
  test('ignores subagent observations and malformed lines', () => {
    expect(
      claudeTranscriptState([
        ...lines,
        'null',
        '{',
        assistant({ isSidechain: true, effort: 'low', message: { model: 'other' } }),
      ])
    ).toMatchObject(observed);
  });
  test('keeps last observed identity while the next user turn has no assistant yet', () => {
    expect(
      claudeTranscriptState([
        ...lines,
        JSON.stringify({ type: 'user', message: { content: 'next' } }),
      ])
    ).toMatchObject(observed);
  });
  test('both adapters expose the same schema-preserved observation on fresh status reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-identity-'));
    try {
      await mkdir(join(dir, '-fixture'));
      const path = join(dir, '-fixture', 'session.jsonl');
      await writeFile(path, fixture);
      const deps = {
        machine: 'fixture',
        projectsDir: dir,
        liveSessions: async () => [
          { sessionId: 'session', pid: 1, owner: 'cli' as const, name: 'worker', status: 'busy' },
        ],
        folder: async () => '/fixture',
      };
      const cli = await readClaudeCliStatus(
        { adapter: 'claude-code', id: 'session' },
        undefined,
        undefined,
        deps
      );
      expect(cli).toMatchObject({ ok: true, value: observed });
      if (!cli.ok) throw new Error('Expected status');
      expect(WorkDetailSchema.parse(cli.value)).toHaveProperty(
        'identityObservation.source',
        'assistant-transcript'
      );
      const desktop = describeClaudeSession(
        {
          sessionId: 'desktop',
          cliSessionId: 'session',
          title: 'fixture',
          isArchived: false,
          lastActivityAt: 0,
        },
        [],
        claudeTranscriptState(lines),
        deps
      );
      expect(desktop).toMatchObject({ ok: true, value: observed });
      await writeFile(
        path,
        assistant({ effort: 'low', message: { model: 'claude-sonnet-5', content: [] } })
      );
      expect(
        await readClaudeCliStatus(
          { adapter: 'claude-code', id: 'session' },
          undefined,
          undefined,
          deps
        )
      ).toMatchObject({ value: { model: 'claude-sonnet-5', effort: 'low' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
