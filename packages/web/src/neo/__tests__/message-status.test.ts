import type { AgentProcessingState } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import {
  admitNeoMessageStatusLink,
  type NeoMessageStatusLink,
  neoRepliedAsks,
  placeNeoMessageTurn,
  projectNeoMessageStatuses,
} from '../message-status.ts';
import type { NeoPublicEntry } from '../public-conversation.ts';

const ask = (requestId: string, failed = false) =>
  ({
    kind: 'ask',
    key: requestId,
    ask: {
      requestId,
      askOrigin: { sessionId: 'neo', messageId: requestId },
      ...(failed ? { delivery: { state: 'failed' } } : {}),
    },
  }) as unknown as NeoPublicEntry;
const reply = (requestId: string) =>
  ({
    kind: 'publication',
    key: `reply-${requestId}`,
    publication: { askOrigin: { sessionId: 'neo', messageId: requestId } },
    replyTo: { requestId },
  }) as unknown as NeoPublicEntry;
const working: AgentProcessingState = { status: 'processing', messageId: 'B', phase: 'thinking' };
const starting = { status: 'queued', messageId: 'B' } as AgentProcessingState;
const idle = { status: 'idle' } as AgentProcessingState;
const live: NeoMessageStatusLink = { connected: true, status: 'ready' };
const read = (map: ReadonlyMap<string, string>) => Object.fromEntries(map);

describe('projectNeoMessageStatuses', () => {
  it('walks a message from received through working to answered', () => {
    const entries = [ask('A'), reply('A'), ask('B'), ask('C')];
    expect(read(projectNeoMessageStatuses(entries, 'inactive', idle, live))).toEqual({
      A: 'answered',
      B: 'received',
      C: 'received',
    });
    expect(
      read(projectNeoMessageStatuses(entries, { label: '', messageId: 'B' }, starting, live))
    ).toEqual({
      A: 'answered',
      B: 'queued',
      C: 'queued',
    });
    expect(
      read(projectNeoMessageStatuses(entries, { label: '', messageId: 'B' }, working, live))
    ).toEqual({
      A: 'answered',
      B: 'working',
      C: 'queued',
    });
    expect(
      read(projectNeoMessageStatuses([...entries, reply('B')], 'inactive', idle, live))
    ).toEqual({
      A: 'answered',
      B: 'answered',
      C: 'received',
    });
  });

  it('treats any reply as answered and a lost message as failed', () => {
    expect(
      read(
        projectNeoMessageStatuses([ask('A'), reply('A'), ask('B', true)], 'inactive', idle, live)
      )
    ).toEqual({
      A: 'answered',
      B: 'failed',
    });
  });

  it('works on the oldest open message when the turn names none', () => {
    expect(
      read(
        projectNeoMessageStatuses(
          [ask('A'), ask('B')],
          { label: '', messageId: null },
          working,
          live
        )
      )
    ).toEqual({
      A: 'working',
      B: 'queued',
    });
  });

  it('keeps a newer message open when an earlier one is answered after it', () => {
    expect(
      read(
        projectNeoMessageStatuses(
          [ask('A'), ask('B'), reply('A')],
          { label: '', messageId: 'B' },
          working,
          live
        )
      )
    ).toEqual({
      A: 'answered',
      B: 'working',
    });
  });

  it('never shows a live state without a live link', () => {
    const entries = [ask('A'), reply('A'), ask('B')];
    const activity = { label: '', messageId: 'B' };
    expect(
      read(
        projectNeoMessageStatuses(entries, activity, working, { connected: false, status: 'ready' })
      )
    ).toEqual({
      A: 'answered',
      B: 'disconnected',
    });
    expect(
      read(
        projectNeoMessageStatuses(entries, activity, working, {
          connected: true,
          status: 'unavailable',
        })
      )
    ).toEqual({ A: 'answered', B: 'stale' });
  });
});

describe('Neo answer attribution', () => {
  it('an explicit human trigger answers its chosen input, not the turn producer as well', () => {
    const selected = {
      ...reply('B'),
      publication: {
        askOrigin: { sessionId: 'neo', messageId: 'B' },
        producerInput: { sessionId: 'neo', messageId: 'A' },
        triggerId: 'human:B',
      },
    } as unknown as NeoPublicEntry;
    expect(
      read(projectNeoMessageStatuses([ask('A'), ask('B'), selected], 'inactive', idle, live))
    ).toEqual({ A: 'received', B: 'answered' });
  });
  it('a saved selected-answer revision does not answer its different original producer', () => {
    const selected = {
      ...reply('B'),
      publication: {
        askOrigin: { sessionId: 'neo', messageId: 'B' },
        producerInput: { sessionId: 'neo', messageId: 'A' },
        triggerId: 'human:B',
        revisions: [
          {
            producerInput: { sessionId: 'neo', messageId: 'A' },
            askOrigin: { sessionId: 'neo', messageId: 'B' },
          },
        ],
      },
    } as unknown as NeoPublicEntry;
    expect([...neoRepliedAsks([ask('A'), ask('B'), selected])]).toEqual(['B']);
  });
  it('recognizes every attributed reply', () => {
    expect([...neoRepliedAsks([ask('A'), reply('A'), ask('B'), reply('B')])]).toEqual(['A', 'B']);
  });

  it('attributes current and saved revisions without moving the original reply', () => {
    const revised = {
      ...reply('A'),
      publication: {
        askOrigin: { sessionId: 'neo', messageId: 'A' },
        answerInput: { sessionId: 'neo', messageId: 'C' },
        revisions: [
          { producerInput: { sessionId: 'neo', messageId: 'B' } },
          { producerInput: { sessionId: 'other', messageId: 'D' } },
        ],
      },
    } as unknown as NeoPublicEntry;
    expect([...neoRepliedAsks([ask('A'), revised, ask('B'), ask('C'), ask('D')])]).toEqual([
      'A',
      'B',
      'C',
    ]);
  });
  it('recognizes human origins behind current and earlier forwarded revisions', () => {
    const revised = {
      ...reply('A'),
      publication: {
        askOrigin: { sessionId: 'neo', messageId: 'A' },
        answerInput: { sessionId: 'holder', messageId: 'neo-forward:C:0' },
        answerOrigin: { sessionId: 'neo', messageId: 'C' },
        revisions: [
          {
            producerInput: { sessionId: 'holder', messageId: 'neo-forward:B:0' },
            askOrigin: { sessionId: 'neo', messageId: 'B' },
          },
        ],
      },
    } as unknown as NeoPublicEntry;
    expect([...neoRepliedAsks([ask('A'), revised, ask('B'), ask('C')])]).toEqual(['A', 'B', 'C']);
  });
});

describe('placeNeoMessageTurn', () => {
  it('names no turn while Neo is idle', () => {
    expect(placeNeoMessageTurn([ask('A')], new Set(), 'inactive')).toMatchObject({
      working: null,
    });
  });
});

describe('admitNeoMessageStatusLink', () => {
  it('rejects a dropped connection before a stale conversation', () => {
    expect(admitNeoMessageStatusLink({ connected: false, status: 'unavailable' })).toEqual({
      reason: 'disconnected',
    });
    expect(admitNeoMessageStatusLink(live)).toEqual({ value: live });
  });
});
