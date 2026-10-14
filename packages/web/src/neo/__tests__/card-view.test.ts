import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskView, NeoCardView } from '@hyperneo/shared/types/neo-snapshot';
import { describe, expect, it } from 'vitest';
import {
  neoCardLabel,
  neoCardMeta,
  neoCardOpenLabel,
  neoCardPrimaryAction,
  neoCardTone,
  neoContinuedLabel,
} from '../card-view.ts';
import { describeNeoAskFromView, groupNeoAsks, neoAskOpenTarget } from '../neo-asks.ts';
import type { NeoProjectBoard } from '../neo-project-board.ts';
import { classifyNeoScenes, describeNeoCardScenes, groupNeoScenes } from '../neo-scenes.ts';

type Receipt = NeoProjectBoard['receipts'][number];

const work = (id: string, status: NeoWork['status'], sessionId: string | null = null): NeoWork => ({
  id,
  requestKey: id,
  projectId: null,
  originSessionId: 'root',
  originMessageId: 'm',
  title: `Card ${id}`,
  instruction: '',
  sessionId,
  status,
  report: null,
  createdAt: 1,
  updatedAt: 2,
});

const card = (workId: string, extra: Partial<NeoCardView> = {}): NeoCardView => ({
  workId,
  phase: 'running',
  group: 'running',
  tone: 'accent',
  label: 'Running in Codex Desktop',
  hidden: false,
  primary: { kind: 'open', label: 'Open in Codex', link: 'codex://threads/t1' },
  actions: ['done', 'close'],
  adapter: 'codex-desktop',
  open: { link: 'codex://threads/t1', remoteLink: null, sessionId: null, daemon: null },
  pr: null,
  goal: null,
  doneWhen: null,
  continued: 0,
  continuedMessage: null,
  pooled: false,
  superseded: false,
  uncheckedSince: null,
  checkedAt: null,
  unconfirmed: false,
  abandoned: false,
  retryable: false,
  ...extra,
});

const ask = (id: string, workIds: string[]): NeoAsk => ({
  id,
  requestKey: id,
  projectId: null,
  originSessionId: 'root',
  originMessageId: 'm',
  title: `Ask ${id}`,
  ask: id,
  doneWhen: '',
  doneSource: 'human',
  status: 'open',
  outcome: null,
  workIds,
  createdAt: 1,
  updatedAt: 2,
  settledAt: null,
});

const askView = (askId: string, extra: Partial<NeoAskView> = {}): NeoAskView => ({
  askId,
  group: 'running',
  label: 'Working on it',
  settled: false,
  needsYou: false,
  done: 1,
  total: 2,
  workIds: ['w1', 'w2'],
  doneWorkIds: ['w1'],
  summary: 'Halfway there.',
  ...extra,
});

describe('neoCardLabel', () => {
  it('adds the local check time only to live phases', () => {
    const at = new Date(2026, 9, 11, 9, 5).getTime();
    expect(neoCardLabel(card('w', { uncheckedSince: at }))).toMatch(
      /^Running in Codex Desktop · not checked since 9:05/
    );
    expect(neoCardLabel(card('w', { phase: 'stopped', uncheckedSince: at }))).toBe(
      'Running in Codex Desktop'
    );
  });

  it('shows when Neo last checked a live card, and lets not-checked win', () => {
    const at = new Date(2026, 9, 11, 14, 15).getTime();
    const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(neoCardLabel(card('w', { checkedAt: at }))).toBe(
      `Running in Codex Desktop · checked ${time}`
    );
    expect(neoCardLabel(card('w', { checkedAt: at, uncheckedSince: at }))).toBe(
      `Running in Codex Desktop · not checked since ${time}`
    );
    expect(neoCardLabel(card('w', { phase: 'merged', checkedAt: at }))).toBe(
      'Running in Codex Desktop'
    );
  });
});

describe('neoContinuedLabel', () => {
  it('says once for one continue and counts times after', () => {
    expect([1, 2, 5].map(neoContinuedLabel)).toEqual([
      'Neo continued it once',
      'Neo continued it 2 times',
      'Neo continued it 5 times',
    ]);
  });
});

describe('neoCardPrimaryAction', () => {
  it('uses the daemon action and layers chat questions on top', () => {
    const queued = work('w', 'queued', 's1');
    const chat = card('w', { primary: { kind: 'chat', label: 'Open chat', link: null } });
    expect(neoCardPrimaryAction(chat, queued, { chat: true })).toEqual({
      kind: 'chat',
      label: 'Open chat',
    });
    expect(neoCardPrimaryAction(chat, queued, { chat: true, waiting: true })).toEqual({
      kind: 'answer',
      label: 'Answer in chat',
      link: null,
    });
    expect(neoCardPrimaryAction(chat, queued)).toEqual({ kind: 'none' });
    expect(neoCardPrimaryAction(card('w'), work('w', 'queued'))).toEqual({
      kind: 'open',
      label: 'Open in Codex',
      link: 'codex://threads/t1',
    });
  });
});

describe('neoCardTone', () => {
  it('warns while a queued card waits on a chat answer', () => {
    expect(neoCardTone(card('w'), work('w', 'queued'), true)).toBe('warning');
    expect(neoCardTone(card('w'), work('w', 'queued'), false)).toBe('accent');
  });
});

describe('neoCardMeta', () => {
  it('prefers the PR number and reads retryable from the card', () => {
    const pr = {
      number: '#7',
      label: 'x',
      count: 1,
      inProgress: true,
      setback: false,
      merged: [],
    };
    expect(neoCardMeta(card('w', { pr }), work('w', 'reported'))).toBe('PR #7');
    expect(neoCardMeta(card('w', { retryable: true }), work('w', 'failed'), 1)).not.toMatch(
      /^Started/
    );
  });
});

describe('neoCardOpenLabel', () => {
  it('names the app from the adapter', () => {
    expect(neoCardOpenLabel(card('w'))).toBe('Open in Codex');
    expect(neoCardOpenLabel(card('w', { adapter: null }))).toBe('Open chat');
  });
});

describe('describeNeoCardScenes', () => {
  it('takes the group and label from the card view', () => {
    const [scene] = describeNeoCardScenes(
      classifyNeoScenes([{ ...work('w', 'queued'), kind: 'work' } as Receipt]),
      new Map([['w', card('w', { group: 'attention', label: 'Needs you in Codex Desktop' })]])
    );
    expect(scene).toMatchObject({ group: 'attention', label: 'Needs you in Codex Desktop' });
  });
});

describe('describeNeoAskFromView', () => {
  const scenes = classifyNeoScenes([
    { ...work('w1', 'reported', 's1'), kind: 'work' } as Receipt,
    { ...work('w2', 'queued', 's2'), kind: 'work' } as Receipt,
    { ...work('gone', 'cancelled', 's3'), kind: 'work' } as Receipt,
  ]);

  it('renders the published counts and keeps only live cards', () => {
    const view = describeNeoAskFromView(ask('a', ['w1', 'w2', 'gone']), scenes, askView('a'));
    expect(view).toMatchObject({ group: 'running', label: 'Working on it', done: 1, total: 2 });
    expect(view.scenes.map((scene) => scene.ref.id)).toEqual(['w1', 'w2']);
    expect([...view.doneIds]).toEqual(['w1']);
    expect(view.summary).toBe('Halfway there.');
  });

  it('a chat question on a live card still raises the ask to needs you', () => {
    const asked = scenes.map((scene) =>
      scene.ref.id === 'w2' ? { ...scene, group: 'attention' as const } : scene
    );
    const view = describeNeoAskFromView(ask('a', ['w1', 'w2']), asked, askView('a'));
    expect(view).toMatchObject({ group: 'attention', label: 'Needs you' });
  });
});

describe('groupNeoAsks', () => {
  it('uses the published ask view and the cards for superseded work', () => {
    const groups = groupNeoScenes(
      classifyNeoScenes([
        { ...work('w1', 'reported', 's1'), kind: 'work' } as Receipt,
        { ...work('old', 'failed', 's2'), kind: 'work' } as Receipt,
      ])
    );
    const result = groupNeoAsks(
      [ask('a', ['w1'])],
      groups,
      [askView('a', { group: 'outcomes', label: 'Done', settled: true, workIds: ['w1'] })],
      new Map([['old', card('old', { superseded: true, phase: 'failed' })]])
    );
    expect(result.asks.outcomes.map((view) => view.label)).toEqual(['Done']);
    expect(result.loose.outcomes).toEqual([]);
  });
});

describe('neoAskOpenTarget', () => {
  it('opens the card view link for work without a session', () => {
    const scenes = classifyNeoScenes([{ ...work('w', 'queued'), kind: 'work' } as Receipt]);
    const view = describeNeoAskFromView(ask('a', ['w']), scenes, askView('a', { workIds: ['w'] }));
    const target = neoAskOpenTarget(view, new Map([['w', card('w')]]));
    expect(target).toMatchObject({ link: 'codex://threads/t1', card: { workId: 'w' } });
  });
});
