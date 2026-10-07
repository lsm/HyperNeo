import type { AgentProcessingState, ChatMessage, SessionState } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import {
  neoAwaitingReply,
  projectNeoProcessingActivity,
  scopeNeoProcessingAsk,
  scopeNeoProcessingStatus,
  selectNeoProcessingStatus,
} from '../processing-activity.ts';

const processing = (messageId = 'ask-A'): AgentProcessingState => ({
  status: 'processing',
  messageId,
  phase: 'thinking',
});
const cooldown = (messageId = 'ask-A'): AgentProcessingState => ({
  status: 'rate_limit_cooldown',
  retryCount: 1,
  maxRetries: 3,
  retryAt: 5,
  messageId,
});

function state(agentState: AgentProcessingState, sessionId = 'neo'): SessionState {
  return {
    sessionInfo: { id: sessionId },
    agentState,
    commandsData: { availableCommands: [] },
    error: null,
    timestamp: 1,
  } as unknown as SessionState;
}

function ask(
  uuid: string,
  options: {
    inputKind?: string;
    legacy?: boolean;
    sessionId?: string;
    parentToolUseId?: string | null;
  } = {}
): ChatMessage {
  return {
    type: 'user',
    uuid,
    session_id: options.sessionId ?? 'neo',
    parent_tool_use_id: options.parentToolUseId ?? null,
    ...(!options.legacy ? { inputKind: options.inputKind ?? 'human' } : {}),
    message: { role: 'user', content: uuid },
  } as unknown as ChatMessage;
}

function nonHumanMessage(type: 'assistant' | 'system', uuid: string): ChatMessage {
  return {
    type,
    uuid,
    session_id: 'neo',
    parent_tool_use_id: null,
    message: { role: type, content: 'Not a human input' },
  } as unknown as ChatMessage;
}

function toolResultMessage(uuid: string): ChatMessage {
  return {
    type: 'user',
    uuid,
    session_id: 'neo',
    parent_tool_use_id: null,
    inputKind: 'system',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }],
    },
  } as unknown as ChatMessage;
}

const visible = [ask('ask-A'), ask('ask-B')];

type Overrides = Partial<{
  sessionId: string;
  activeSessionId: string | null;
  sessionState: SessionState | null;
  fallbackState: AgentProcessingState;
  connected: boolean;
  recovering: boolean;
  messages: readonly ChatMessage[];
}>;

function select(overrides: Overrides = {}) {
  const fallbackState = overrides.fallbackState ?? processing();
  return projectNeoProcessingActivity(
    overrides.sessionId ?? 'neo',
    overrides.activeSessionId ?? 'neo',
    overrides.sessionState === undefined ? state(fallbackState) : overrides.sessionState,
    fallbackState,
    overrides.connected ?? true,
    overrides.recovering ?? false,
    overrides.messages ?? visible
  );
}

describe('Neo processing activity selector', () => {
  it('keeps the existing labels and attributes queued, processing, and cooldown to their exact input', () => {
    expect(select({ sessionState: state({ status: 'queued', messageId: 'ask-A' }) })).toEqual({
      label: 'Neo is getting ready…',
      messageId: 'ask-A',
    });
    expect(select()).toEqual({ label: 'Neo is working on a reply…', messageId: 'ask-A' });
    expect(
      select({
        sessionState: state({ status: 'processing', messageId: 'ask-A', phase: 'initializing' }),
      })
    ).toEqual({ label: 'Neo is getting ready…', messageId: 'ask-A' });
    expect(select({ sessionState: state(cooldown()) })).toEqual({
      label: 'Neo is waiting to retry…',
      messageId: 'ask-A',
    });
  });

  it.each<AgentProcessingState>([
    { status: 'idle' },
    { status: 'interrupted' },
    { status: 'waiting_for_input', pendingQuestion: {} as never },
  ])('clears the root activity for inactive state %j', (agentState) => {
    expect(select({ sessionState: state(agentState), fallbackState: agentState })).toBe('inactive');
  });

  const sessionError = state(processing());
  sessionError.error = { message: 'failed', occurredAt: 2 };
  it.each<[string, Overrides]>([
    ['missing native state', { sessionState: null }],
    ['offline', { connected: false }],
    ['recovering', { recovering: true }],
    ['selected view mismatch', { activeSessionId: 'other' }],
    ['native session mismatch', { sessionState: state(processing(), 'other') }],
    ['native error', { sessionState: sessionError }],
  ])('keeps %s status generic', (_name, overrides) => {
    expect(select(overrides)).toEqual({ label: 'Neo is working on a reply…', messageId: null });
  });

  it.each<[string, Overrides]>([
    ['unknown or truncated ID', { messages: [ask('ask-B')] }],
    ['legacy input', { messages: [ask('ask-A', { legacy: true })] }],
    ['system return', { messages: [ask('ask-A', { inputKind: 'system' })] }],
    ['duplicate visible ID', { messages: [ask('ask-A'), ask('ask-A')] }],
    ['cross-view input', { messages: [ask('ask-A', { sessionId: 'other' })] }],
    ['tool child', { messages: [ask('ask-A', { parentToolUseId: 'tool' })] }],
  ])('keeps %s origin generic', (_name, overrides) => {
    expect(select(overrides)).toEqual({ label: 'Neo is working on a reply…', messageId: null });
  });

  it('keeps a message without an exact input ID generic', () => {
    const noId: AgentProcessingState = {
      status: 'rate_limit_cooldown',
      retryCount: 1,
      maxRetries: 3,
      retryAt: 5,
    };
    expect(select({ sessionState: state(noId), fallbackState: noId })).toEqual({
      label: 'Neo is waiting to retry…',
      messageId: null,
    });
  });

  it('does not scope status to a blank session ID', () => {
    expect(
      select({ sessionId: '  ', activeSessionId: '  ', sessionState: state(processing(), '  ') })
    ).toEqual({ label: 'Neo is working on a reply…', messageId: null });
  });
});

describe('selectNeoProcessingStatus', () => {
  it.each<
    [
      SessionState | null,
      AgentProcessingState,
      { value: { label: string; messageId: string | null } } | { reason: 'inactive' },
    ]
  >([
    [
      null,
      { status: 'queued', messageId: 'A' },
      { value: { label: 'Neo is getting ready…', messageId: 'A' } },
    ],
    [
      state({ status: 'processing', messageId: 'A', phase: 'initializing' }),
      processing('B'),
      { value: { label: 'Neo is getting ready…', messageId: 'A' } },
    ],
    [
      state({ status: 'processing', messageId: 'A', phase: 'thinking' }),
      processing('B'),
      { value: { label: 'Neo is working on a reply…', messageId: 'A' } },
    ],
    [
      state(cooldown('A')),
      processing('B'),
      { value: { label: 'Neo is waiting to retry…', messageId: 'A' } },
    ],
    [state({ status: 'idle' }), processing('B'), { reason: 'inactive' }],
    [state({ status: 'interrupted' }), processing('B'), { reason: 'inactive' }],
    [
      state({ status: 'waiting_for_input', pendingQuestion: {} as never }),
      processing('B'),
      { reason: 'inactive' },
    ],
  ])(
    'selects the native processing state for its label and input',
    (native, fallback, expected) => {
      expect(selectNeoProcessingStatus(native, fallback)).toEqual(expected);
    }
  );

  it('uses the fallback only when the native state has not loaded', () => {
    expect(selectNeoProcessingStatus(null, processing('fallback'))).toEqual({
      value: { label: 'Neo is working on a reply…', messageId: 'fallback' },
    });
  });
});

describe('scopeNeoProcessingStatus', () => {
  const activity = { label: 'Neo is working on a reply…', messageId: 'ask-A' };

  it.each<[string, string, string | null, SessionState | null, boolean, boolean, string | null]>([
    ['current session', 'neo', 'neo', state(processing()), true, false, 'ask-A'],
    ['blank view id', '  ', '  ', state(processing(), '  '), true, false, null],
    ['missing native state', 'neo', 'neo', null, true, false, null],
    ['offline', 'neo', 'neo', state(processing()), false, false, null],
    ['recovering', 'neo', 'neo', state(processing()), true, true, null],
    ['wrong active session', 'neo', 'other', state(processing()), true, false, null],
    ['wrong native session', 'neo', 'neo', state(processing(), 'other'), true, false, null],
  ])(
    'allows attribution only for %s',
    (_name, sessionId, activeId, native, connected, recovering, expectedId) => {
      expect(
        scopeNeoProcessingStatus(activity, sessionId, activeId, native, connected, recovering).value
          .messageId
      ).toBe(expectedId);
    }
  );

  it('keeps an error-bearing session and whitespace runtime input generic', () => {
    const failed = state(processing());
    failed.error = { message: 'failed', occurredAt: 2 };
    expect(
      scopeNeoProcessingStatus(activity, 'neo', 'neo', failed, true, false).value.messageId
    ).toBeNull();
    expect(
      scopeNeoProcessingStatus(
        { ...activity, messageId: '  ' },
        'neo',
        'neo',
        state(processing()),
        true,
        false
      ).value.messageId
    ).toBeNull();
  });
});

describe('scopeNeoProcessingAsk', () => {
  const activity = { label: 'Neo is working on a reply…', messageId: 'ask-A' };

  it('retains one exact top-level human input', () => {
    expect(scopeNeoProcessingAsk(activity, 'neo', [ask('ask-A')])).toEqual({ value: activity });
  });

  it.each<[string, string | null, readonly ChatMessage[]]>([
    ['blank runtime ID', '  ', [ask('ask-A')]],
    ['unknown or truncated ID', 'missing', [ask('ask-A')]],
    ['legacy input without provenance', 'ask-A', [ask('ask-A', { legacy: true })]],
    ['system-return input', 'ask-A', [ask('ask-A', { inputKind: 'system' })]],
    ['nested tool input', 'ask-A', [ask('ask-A', { parentToolUseId: 'tool' })]],
    ['conflicting session ID', 'ask-A', [ask('ask-A', { sessionId: 'other' })]],
    ['assistant row', 'ask-A', [nonHumanMessage('assistant', 'ask-A')]],
    ['system row', 'ask-A', [nonHumanMessage('system', 'ask-A')]],
    ['tool-result row', 'ask-A', [toolResultMessage('ask-A')]],
    [
      'duplicate UUID with non-human row',
      'ask-A',
      [ask('ask-A'), nonHumanMessage('assistant', 'ask-A')],
    ],
  ])('keeps %s attribution generic', (_name, messageId, messages) => {
    expect(
      scopeNeoProcessingAsk({ ...activity, messageId }, 'neo', messages).value.messageId
    ).toBeNull();
  });
});

describe('projectNeoProcessingActivity', () => {
  it('returns synchronously', () => {
    const result = projectNeoProcessingActivity(
      'neo',
      'neo',
      state(processing()),
      processing(),
      true,
      false,
      visible
    );
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe('neoAwaitingReply', () => {
  const ask = (messageId: string) =>
    ({
      kind: 'ask',
      key: messageId,
      ask: { askOrigin: { sessionId: 'holder', messageId } },
    }) as never;
  const reply = (messageId: string, interim?: true) =>
    ({
      kind: 'publication',
      key: `reply-${messageId}`,
      publication: { interim, askOrigin: { sessionId: 'holder', messageId } },
    }) as never;

  it('waits until the newest ask has its own final reply', () => {
    expect(neoAwaitingReply([ask('A')])).toBe(true);
    expect(neoAwaitingReply([ask('A'), reply('A', true)])).toBe(true);
    expect(neoAwaitingReply([ask('A'), reply('A')])).toBe(false);
    expect(neoAwaitingReply([])).toBe(false);
  });

  it('keeps waiting for a newer ask when an earlier ask is answered after it', () => {
    expect(neoAwaitingReply([ask('A'), reply('A', true), ask('B'), reply('A')])).toBe(true);
    expect(neoAwaitingReply([ask('A'), ask('B'), reply('A'), reply('B')])).toBe(false);
  });
});
