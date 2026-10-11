import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { describe, expect, it } from 'vitest';
import {
  neoWorkMeta,
  neoWorkOpenLabel,
  neoWorkPresentation,
  neoWorkPrimaryAction,
} from '../work-actions.ts';

const work = (status: NeoWork['status'], extra: Partial<NeoWork> = {}): NeoWork => ({
  id: 'w1',
  requestKey: 'w1',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'ask-1',
  title: 'Bigger font',
  instruction: 'Raise the body font to 16px.',
  targetSessionId: null,
  sessionId: null,
  status,
  report: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const retryable = {
  workId: 'w1',
  adapter: 'hyperneo',
  daemon: null,
  status: null,
  link: null,
  retryable: true as const,
};
const driver = (adapter: string, status: 'running' | 'needs_you' = 'running') => ({
  workId: 'w1',
  adapter,
  daemon: null,
  status,
  link: adapter === 'codex-desktop' ? 'codex://threads/t1' : 'claude://claude.ai/epitaxy/l1',
});

describe('neoWorkPrimaryAction', () => {
  it('asks you to start proposed work and to retry a hand-off that never started', () => {
    expect(neoWorkPrimaryAction(work('proposed'), undefined)).toEqual({
      kind: 'start',
      label: 'Start work',
    });
    const never = work('failed', { report: 'Could not start the execution: logged out' });
    expect(neoWorkPrimaryAction(never, retryable)).toEqual({ kind: 'retry', label: 'Retry' });
    expect(neoWorkPrimaryAction(never, undefined)).toEqual({ kind: 'none' });
    expect(neoWorkPrimaryAction(work('failed', { report: 'Tests broke' }), undefined)).toEqual({
      kind: 'none',
    });
    expect(
      neoWorkPrimaryAction({ ...never, sessionId: 's1' }, undefined, { chat: true }).kind
    ).toBe('chat');
  });

  it('answers in chat or in the app that needs you, else opens where the work runs', () => {
    expect(
      neoWorkPrimaryAction(work('queued', { sessionId: 's1' }), undefined, {
        waiting: true,
        chat: true,
      })
    ).toEqual({ kind: 'answer', label: 'Answer in chat', link: null });
    expect(neoWorkPrimaryAction(work('queued'), driver('codex-desktop', 'needs_you'))).toEqual({
      kind: 'answer',
      label: 'Answer in Codex',
      link: 'codex://threads/t1',
    });
    expect(neoWorkPrimaryAction(work('queued'), driver('claude-desktop'))).toEqual({
      kind: 'open',
      label: 'Open in Claude Code',
      link: 'claude://claude.ai/epitaxy/l1',
    });
    expect(neoWorkPrimaryAction(work('reported'), driver('codex-desktop', 'needs_you'))).toEqual({
      kind: 'open',
      label: 'Open in Codex',
      link: 'codex://threads/t1',
    });
  });

  it('opens a HyperNeo session as a chat, and offers nothing without a way in', () => {
    const session = work('reported', { sessionId: 's1' });
    expect(neoWorkPrimaryAction(session, driver('codex-desktop'), { chat: true })).toEqual({
      kind: 'chat',
      label: 'Open chat',
    });
    expect(neoWorkPrimaryAction(session, undefined)).toEqual({ kind: 'none' });
    expect(
      neoWorkPrimaryAction(work('queued', { sessionId: 's1' }), undefined, { waiting: true })
    ).toEqual({ kind: 'none' });
  });
});

describe('neoWorkOpenLabel', () => {
  it('names the app, or the chat for HyperNeo', () => {
    expect(neoWorkOpenLabel(driver('codex-desktop'))).toBe('Open in Codex');
    expect(neoWorkOpenLabel(driver('claude-desktop'))).toBe('Open in Claude Code');
    expect(neoWorkOpenLabel(driver('hyperneo'))).toBe('Open chat');
    expect(neoWorkOpenLabel(undefined)).toBe('Open chat');
  });
});

describe('neoWorkMeta', () => {
  it('shows the PR number when there is one, else when the work started, and only the time for work that never started', () => {
    const now = 3 * 60 * 60_000;
    expect(neoWorkMeta(work('queued'), undefined, undefined, now)).toBe('Started 3h ago');
    expect(neoWorkMeta(work('proposed'), undefined, undefined, now)).toBeNull();
    expect(neoWorkMeta(work('cancelled'), undefined, undefined, now)).toBe('3h ago');
    expect(
      neoWorkMeta(
        work('failed', { report: 'Could not start the execution: login expired' }),
        undefined,
        retryable,
        now
      )
    ).toBe('3h ago');
    expect(
      neoWorkMeta(
        work('reported'),
        {
          workId: 'w1',
          waiting: false,
          prs: [
            {
              url: 'https://github.com/lsm/HyperNeo/pull/6013',
              state: 'OPEN',
              checks: 'pending',
              review: 'none',
            },
          ],
        },
        undefined,
        now
      )
    ).toBe('PR #6013');
  });
});

describe('neoWorkPresentation', () => {
  it('keeps a retryable failure in detail so its Retry stays reachable in the compact list', () => {
    const failed = work('failed', { report: 'Could not start the execution: login expired' });
    const compact = { compact: true, attention: false };
    expect(neoWorkPresentation(failed, retryable, compact)).toBe('detail');
    expect(neoWorkPresentation(work('reported'), undefined, compact)).toBe('summary');
    expect(
      neoWorkPresentation(work('failed', { report: 'The agent gave up.' }), undefined, compact)
    ).toBe('summary');
    expect(neoWorkPresentation(work('queued'), undefined, { compact: true, attention: true })).toBe(
      'detail'
    );
    expect(
      neoWorkPresentation(work('reported'), undefined, { compact: false, attention: false })
    ).toBe('detail');
  });
});
