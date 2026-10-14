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
const reply = (requestId: string, interim?: true) =>
  ({
    kind: 'publication',
    key: `reply-${requestId}`,
    publication: { interim, askOrigin: { sessionId: 'neo', messageId: requestId } },
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

  it('treats an interim post as no answer and a lost message as failed', () => {
    expect(
      read(
        projectNeoMessageStatuses(
          [ask('A'), reply('A', true), ask('B', true)],
          'inactive',
          idle,
          live
        )
      )
    ).toEqual({
      A: 'received',
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

describe('neoRepliedAsks', () => {
  it('counts only final replies', () => {
    expect([...neoRepliedAsks([ask('A'), reply('A', true), ask('B'), reply('B')])]).toEqual(['B']);
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
