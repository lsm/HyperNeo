import { describe, expect, test } from 'bun:test';
import { NEO_OTHER_TOPIC } from '@hyperneo/shared/types/neo-ask';
import { neoAskTopic, type NeoAskTopicFacts } from '../../../../src/lib/neo/ask-topic.ts';

const machine = 'm';
const work = (id: string, adapter = 'claude-code') => `work:${machine}\u0000${adapter}\u0000${id}`;
const projects = new Map([
  ['p', { id: 'p', title: 'Shop' }],
  ['q', { id: 'q', title: 'Shop' }],
  ['old', { id: 'p', title: 'Shop' }],
  ['inbox', { id: 'inbox', title: 'Inbox' }],
]);
const aliases = new Map([
  [work('s1'), 'p'],
  [work('s2'), 'q'],
  [work('s3'), 'old'],
  [work('h1', 'hyperneo'), 'q'],
  [`folder:${machine}\u0000/code/shop`, 'p'],
]);
const ask = (patch: Partial<NeoAskTopicFacts['ask']> = {}) => ({
  projectId: null,
  parentId: null,
  topic: null,
  ...patch,
});
const sent = (id: string) => ({
  ref: { adapter: 'claude-code', id },
  place: null,
  requestFrom: null,
});
const facts = (patch: Partial<NeoAskTopicFacts>): NeoAskTopicFacts => ({
  ask: ask(),
  todos: [],
  parent: null,
  machine,
  aliases,
  projects,
  ...patch,
});
const other = { topic: NEO_OTHER_TOPIC, topicKey: `pick:${NEO_OTHER_TOPIC}` };

describe('neoAskTopic', () => {
  test("an ask whose todo runs in a project's session takes that project over Neo's pick", () => {
    expect(neoAskTopic(facts({ ask: ask({ topic: 'X' }), todos: [sent('s1')] }))).toEqual({
      topic: 'Shop',
      topicKey: 'p',
    });
  });

  test('two asks in one project with different picks share a topic, through merges and start places', () => {
    const start = {
      ref: null,
      place: { machine, folder: '/code/shop', name: 'shop' },
      requestFrom: null,
    };
    expect(neoAskTopic(facts({ ask: ask({ topic: 'A' }), todos: [start] }))).toEqual(
      neoAskTopic(facts({ ask: ask({ topic: 'B' }), todos: [sent('s3')] }))
    );
  });

  test('the project with the most todos wins, and the earliest todo breaks a tie', () => {
    expect(neoAskTopic(facts({ todos: [sent('s2'), sent('s1'), sent('s1')] })).topicKey).toBe('p');
    expect(neoAskTopic(facts({ todos: [sent('s2'), sent('s1')] })).topicKey).toBe('q');
  });

  test("a request from a project's session takes that project", () => {
    const request = (from: string) => ({ ref: null, place: null, requestFrom: from });
    expect(neoAskTopic(facts({ todos: [request('claude-code:s1')] }))).toEqual({
      topic: 'Shop',
      topicKey: 'p',
    });
    expect(neoAskTopic(facts({ todos: [request('h1')] })).topicKey).toBe('q');
  });

  test("a request from a session with no project, or on another daemon, keeps Neo's pick", () => {
    const request = (from: string) => ({
      ask: ask({ topic: 'Kids' }),
      todos: [{ ref: null, place: null, requestFrom: from }],
    });
    expect(neoAskTopic(facts(request('claude-code:lonely'))).topicKey).toBe('pick:kids');
    expect(neoAskTopic(facts(request('daemon:d2::s1'))).topicKey).toBe('pick:kids');
  });

  test("a follow-up takes its parent's project or stored pick", () => {
    const child = ask({ parentId: 'parent' });
    expect(
      neoAskTopic(facts({ ask: child, parent: { ask: ask(), todos: [sent('s1')] } })).topicKey
    ).toBe('p');
    expect(
      neoAskTopic(facts({ ask: child, parent: { ask: ask({ topic: 'Home' }), todos: [] } }))
    ).toEqual({ topic: 'Home', topicKey: 'pick:home' });
  });

  test('a follow-up whose parent has no topic falls to the other topic: one step only', () => {
    expect(
      neoAskTopic(
        facts({ ask: ask({ parentId: 'b' }), parent: { ask: ask({ parentId: 'a' }), todos: [] } })
      )
    ).toEqual(other);
  });

  test('two projects with the same title stay two topics', () => {
    const p = neoAskTopic(facts({ todos: [sent('s1')] }));
    const q = neoAskTopic(facts({ todos: [sent('s2')] }));
    expect([p.topic, q.topic]).toEqual(['Shop', 'Shop']);
    expect(p.topicKey).not.toBe(q.topicKey);
  });

  test('picks that differ only in case or spacing share one key and keep their label', () => {
    expect(neoAskTopic(facts({ ask: ask({ topic: 'kids' }) }))).toEqual({
      topic: 'kids',
      topicKey: 'pick:kids',
    });
    expect(neoAskTopic(facts({ ask: ask({ topic: ' Ki ds' }) })).topicKey).toBe('pick:kids');
  });

  test("an ask with its own project and no todos takes the project's title", () => {
    expect(neoAskTopic(facts({ ask: ask({ projectId: 'q', topic: 'X' }) }))).toEqual({
      topic: 'Shop',
      topicKey: 'q',
    });
    expect(neoAskTopic(facts({ ask: ask({ projectId: 'inbox', topic: 'X' }) })).topicKey).toBe(
      'pick:x'
    );
  });

  test('an ask with nothing and one picked as the other topic share the other-topic key', () => {
    expect(neoAskTopic(facts({}))).toEqual(other);
    expect(neoAskTopic(facts({ ask: ask({ topic: NEO_OTHER_TOPIC }) }))).toEqual(other);
  });
});
