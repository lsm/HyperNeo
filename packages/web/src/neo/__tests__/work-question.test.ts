import { describe, expect, it } from 'vitest';
import type { PendingUserQuestion, SessionState } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  projectNeoWorkQuestion,
  requireNeoPendingQuestion,
  requireNeoQuestionOrigin,
  requireNeoQuestionWork,
} from '../work-question.ts';

const work = {
  id: 'work-A',
  sessionId: 'manager-A',
  targetSessionId: 'manager-A',
  status: 'queued',
} as NeoWork;
const question = {
  toolUseId: 'choice-A',
  inputOrigin: { sessionId: 'manager-A', messageId: 'work-A' },
} as PendingUserQuestion;
const state = {
  sessionInfo: { id: 'manager-A' },
  agentState: { status: 'waiting_for_input', pendingQuestion: question },
} as SessionState;

describe('requireNeoQuestionWork', () => {
  it('admits the exact active queued recipient without changing its identity', () => {
    expect(requireNeoQuestionWork(work, 'manager-A', true)).toEqual({ value: work });
    expect(requireNeoQuestionWork({ ...work, targetSessionId: null }, 'manager-A', true)).toEqual({
      value: { ...work, targetSessionId: null },
    });
  });
  it.each(['proposed', 'reported', 'failed', 'cancelled'] as const)('rejects %s work', (status) =>
    expect(requireNeoQuestionWork({ ...work, status }, 'manager-A', true)).toEqual({ reason: null })
  );
  it.each([
    { work, active: null, available: true },
    { work, active: 'manager-B', available: true },
    { work, active: 'manager-A', available: false },
    { work: { ...work, id: ' ' }, active: 'manager-A', available: true },
    { work: { ...work, sessionId: null }, active: null, available: true },
    { work: { ...work, targetSessionId: 'manager-B' }, active: 'manager-A', available: true },
  ])('fails closed at the target boundary: %j', ({ work: input, active, available }) => {
    expect(requireNeoQuestionWork(input, active, available)).toEqual({ reason: null });
  });
});

describe('requireNeoPendingQuestion', () => {
  it('uses only the actual native pending state', () => {
    expect(requireNeoPendingQuestion(work, state)).toEqual({ value: question });
  });
  it.each([
    null,
    { ...state, sessionInfo: { id: 'manager-B' } },
    { ...state, agentState: { status: 'idle' } },
    { ...state, agentState: { status: 'processing', messageId: 'work-A' } },
  ])('rejects absent, changed and nonwaiting state: %j', (input) => {
    expect(requireNeoPendingQuestion(work, input as SessionState | null)).toEqual({ reason: null });
  });
});

describe('requireNeoQuestionOrigin', () => {
  it.each([
    undefined,
    null,
    { sessionId: 'manager-B', messageId: 'work-A' },
    { sessionId: 'manager-A', messageId: 'work-B' },
  ])('rejects unknown or mismatched origins: %j', (inputOrigin) =>
    expect(requireNeoQuestionOrigin({ ...question, inputOrigin }, work)).toEqual({ reason: null })
  );
  it('requires a usable native tool identity', () => {
    expect(requireNeoQuestionOrigin({ ...question, toolUseId: ' ' }, work)).toEqual({
      reason: null,
    });
  });
});

describe('projectNeoWorkQuestion', () => {
  it('returns the exact question without mutating the resource or question', () => {
    const frozenWork = Object.freeze({ ...work });
    const frozenQuestion = Object.freeze({ ...question });
    const frozenState = Object.freeze({
      ...state,
      agentState: { status: 'waiting_for_input' as const, pendingQuestion: frozenQuestion },
    });
    expect(projectNeoWorkQuestion(frozenWork, 'manager-A', true, frozenState)).toBe(frozenQuestion);
    expect(frozenWork).toEqual(work);
    expect(frozenQuestion).toEqual(question);
  });
  it('stops before inspecting native state when work is unavailable', () => {
    const unread = {
      get agentState() {
        throw new Error('must not inspect');
      },
    } as unknown as SessionState;
    expect(projectNeoWorkQuestion(work, 'manager-A', false, unread)).toBeNull();
    expect(
      projectNeoWorkQuestion({ ...work, status: 'reported' }, 'manager-A', true, unread)
    ).toBeNull();
  });
  it('does not inspect a question from the wrong native session', () => {
    const unread = {
      sessionInfo: { id: 'manager-B' },
      get agentState() {
        throw new Error('must not inspect');
      },
    } as unknown as SessionState;
    expect(projectNeoWorkQuestion(work, 'manager-A', true, unread)).toBeNull();
  });
});
