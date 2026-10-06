import { describe, expect, test } from 'bun:test';
import {
  buildClaudeCodeGroups,
  createClaudeCodeAdapter,
} from '../../../../src/lib/drivers/claude-code-adapter';
import { buildClaudeDesktopGroups } from '../../../../src/lib/drivers/claude-desktop-adapter';
import type { WorkChatMatch } from '../../../../src/storage/work-chat-search';

const chat = (sessionId: string, text: string, role = 'user'): WorkChatMatch => ({
  kind: 'claude',
  sessionId,
  taskId: null,
  hits: 2,
  lastHitAt: 500,
  score: 100.1,
  snippets: [{ match: 'exact', messageId: `${sessionId}-m`, sessionId, role, at: 500, text }],
});

describe('buildClaudeCodeGroups', () => {
  test('lists CLI sessions found by content, leaving Desktop sessions to their adapter', () => {
    const groups = buildClaudeCodeGroups(
      [chat('cli-1', 'plan the   heron rollout'), chat('desk-1', 'heron in desktop')],
      new Set(['desk-1']),
      { text: 'heron', includeClosed: false, limit: 20 },
      'laptop'
    );
    expect(groups).toMatchObject([
      {
        place: { machine: 'laptop', name: 'Claude Code' },
        adapters: ['claude-code'],
        work: [
          {
            ref: { adapter: 'claude-code', id: 'cli-1' },
            title: 'plan the heron rollout',
            hits: 2,
            snippets: [{ handle: { sessionId: 'cli-1', messageId: 'cli-1-m' } }],
          },
        ],
      },
    ]);
    expect(
      buildClaudeCodeGroups(
        [chat('cli-1', 'x')],
        new Set(),
        { folder: '/x', includeClosed: false, limit: 5 },
        'laptop'
      )
    ).toEqual([]);
  });
});

describe('createClaudeCodeAdapter', () => {
  test('only searches when asked for text', async () => {
    const searched: string[] = [];
    const adapter = createClaudeCodeAdapter({
      machine: 'laptop',
      searchChats: async (text) => {
        searched.push(text);
        return [chat('cli-2', 'heron')];
      },
      desktopSessions: async () => new Set(),
    });
    expect(await adapter.find({ includeClosed: false, limit: 5 })).toEqual([]);
    expect(
      (await adapter.find({ text: 'heron', includeClosed: false, limit: 5 }))[0]?.work
    ).toHaveLength(1);
    expect(searched).toEqual(['heron']);
  });
});

describe('buildClaudeDesktopGroups with content hits', () => {
  test('lists a Desktop session whose transcript matched, with its snippet', () => {
    const groups = buildClaudeDesktopGroups(
      [
        {
          sessionId: 'local_a',
          cliSessionId: 'desk-1',
          cwd: '/focus/neokai',
          title: 'Untitled',
          isArchived: false,
          lastActivityAt: 1,
        },
        {
          sessionId: 'local_b',
          cliSessionId: 'desk-2',
          cwd: '/focus/neokai',
          title: 'Other',
          isArchived: false,
          lastActivityAt: 2,
        },
      ],
      [],
      { text: 'heron', includeClosed: false, limit: 20 },
      { machine: 'laptop' },
      new Map([['desk-1', chat('desk-1', 'heron notes')]])
    );
    expect(groups.flatMap((group) => group.work)).toMatchObject([
      {
        ref: { adapter: 'claude-desktop', id: 'local_a' },
        hits: 2,
        snippets: [{ text: 'heron notes' }],
      },
    ]);
  });
});
