import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import { describe, expect, it } from 'vitest';
import { createNeoWorkSearch } from '../neo-work-search.ts';

const entry = (
  id: string,
  patch: {
    title?: string;
    todo?: string;
    status?: string;
    next?: string;
    question?: string;
    report?: string;
    evidence?: string;
    outcome?: string;
  } = {}
) =>
  ({
    ask: { id, title: patch.title ?? 'ask', outcome: patch.outcome ?? 'outcome' },
    state: 'todo',
    todos: [
      {
        title: patch.todo ?? 'task',
        status: patch.status ?? 'pending',
        nextAction: patch.next ?? 'next',
        report: patch.report ?? 'report',
        evidence: patch.evidence ?? 'evidence',
      },
    ],
    questions: [{ text: patch.question ?? 'question' }],
  }) as NeoAskEntry;
const ids = (entries: NeoAskEntry[]) => entries.map((item) => item.ask.id);

describe('Work search ranking', () => {
  it('ranks ask title, todo title, status and report matches by the specified field weights', () => {
    const search = createNeoWorkSearch([
      entry('report', { report: 'needle' }),
      entry('status', { status: 'needle' }),
      entry('todo', { todo: 'needle' }),
      entry('ask', { title: 'needle' }),
    ]);
    expect(ids(search('needle'))).toEqual(['ask', 'todo', 'status', 'report']);
  });
  it('finds next actions, questions, evidence and outcomes', () => {
    const search = createNeoWorkSearch([
      entry('next', { next: 'advance' }),
      entry('question', { question: 'permission' }),
      entry('evidence', { evidence: 'observed' }),
      entry('outcome', { outcome: 'finished' }),
    ]);
    for (const [query, id] of [
      ['advance', 'next'],
      ['permission', 'question'],
      ['observed', 'evidence'],
      ['finished', 'outcome'],
    ])
      expect(ids(search(query))).toEqual([id]);
  });
  it('normalizes words and matches CJK unigrams, bigrams and mixed-script queries', () => {
    const search = createNeoWorkSearch([
      entry('cjk', { title: 'fix接口数据库' }),
      entry('english', { title: 'FIX database' }),
    ]);
    expect(ids(search('ＦＩＸ'))).toEqual(['english', 'cjk']);
    for (const query of ['数', '数据', '接口', 'fix接口'])
      expect(ids(search(query))).toContain('cjk');
    expect(search('databaseunknown')).toEqual([]);
  });
  it('normalizes field length and preserves feed order on equal scores', () => {
    const long = entry('long', { title: `needle ${'filler '.repeat(30)}` }),
      short = entry('short', { title: 'needle' });
    expect(ids(createNeoWorkSearch([long, short])('needle'))).toEqual(['short', 'long']);
    expect(ids(createNeoWorkSearch([entry('second'), entry('first')])('ask'))).toEqual([
      'second',
      'first',
    ]);
  });
  it('returns no work for unmatched or token-free queries and does not multiply repeated terms', () => {
    const search = createNeoWorkSearch([
      entry('a', { title: 'needle other' }),
      entry('b', { title: 'needle' }),
    ]);
    for (const query of ['', '  ', '?!', 'unmatched']) expect(search(query)).toEqual([]);
    expect(ids(search('needle needle other'))).toEqual(ids(search('needle other')));
  });
});
