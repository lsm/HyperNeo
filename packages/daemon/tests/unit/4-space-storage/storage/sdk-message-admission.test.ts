import { describe, expect, test } from 'bun:test';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  decideMessageAdmission,
  normalizeMessageAdmissionInput,
  type SendStatus,
} from '../../../../src/storage/repositories/sdk-message-admission';

const asMsg = (payload: Record<string, unknown>): SDKMessage => payload as unknown as SDKMessage;

function userMessage(uuid: string, extra: Record<string, unknown> = {}): SDKMessage {
  return asMsg({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: `text-${uuid}` }] },
    ...extra,
  });
}

function toolResultUserMessage(uuid: string): SDKMessage {
  return asMsg({
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'result' }],
    },
  });
}

function assistantMessage(uuid: string, extra: Record<string, unknown> = {}): SDKMessage {
  return asMsg({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text: `text-${uuid}` }] },
    ...extra,
  });
}

function resultMessage(uuid: string): SDKMessage {
  return asMsg({ type: 'result', subtype: 'success', uuid, is_error: false, result: 'done' });
}

function actionMessage(uuid: string): HyperNeoActionMessage {
  return {
    type: 'hyperneo_action',
    uuid,
    session_id: 'sess-action',
    action: 'sdk_resume_choice',
    resolved: false,
    timestamp: Date.parse('2026-02-03T04:05:06.000Z'),
  };
}

describe('decideMessageAdmission (chain B2)', () => {
  describe('sdk variant: anchor is not send-status gated', () => {
    test('renderable user message admits as anchor with badge, uuid, and replacement edges', () => {
      const record = decideMessageAdmission(
        normalizeMessageAdmissionInput(userMessage('u-1', { supersedes: ['edge-a'] })),
        { variant: 'sdk', sendStatus: null }
      );
      expect(record).toEqual({
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: true,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'u-1',
        replacementEdges: [{ targetUuid: 'edge-a', kind: 'superseded' }],
      });
    });

    test('a non-renderable user tool-result message does not anchor but still counts toward the badge', () => {
      const record = decideMessageAdmission(
        normalizeMessageAdmissionInput(toolResultUserMessage('u-tool')),
        { variant: 'sdk', sendStatus: null }
      );
      expect(record.isRenderable).toBe(0);
      expect(record.isConversationAnchor).toBe(false);
      expect(record.countsTowardsBadge).toBe(true);
    });

    test('a terminal result message is admitted as terminal without anchoring', () => {
      const record = decideMessageAdmission(normalizeMessageAdmissionInput(resultMessage('r-1')), {
        variant: 'sdk',
        sendStatus: null,
      });
      expect(record.isTerminal).toBe(1);
      expect(record.isConversationAnchor).toBe(false);
      expect(record.countsTowardsBadge).toBe(true);
    });

    test('a subagent row carries its parent tool use id and never counts toward the badge', () => {
      const record = decideMessageAdmission(
        normalizeMessageAdmissionInput(assistantMessage('a-sub', { parent_tool_use_id: 'tu_1' })),
        { variant: 'sdk', sendStatus: null }
      );
      expect(record.parentToolUseId).toBe('tu_1');
      expect(record.countsTowardsBadge).toBe(false);
    });

    test('a badge-hidden subtype never counts toward the badge', () => {
      const record = decideMessageAdmission(
        normalizeMessageAdmissionInput(asMsg({ type: 'system', subtype: 'task_started' })),
        { variant: 'sdk', sendStatus: null }
      );
      expect(record.countsTowardsBadge).toBe(false);
      expect(record.isConversationAnchor).toBe(false);
    });

    test('retracted edges are admitted only under the model_refusal_fallback subtype', () => {
      const refusal = decideMessageAdmission(
        normalizeMessageAdmissionInput(
          userMessage('u-refusal', {
            subtype: 'model_refusal_fallback',
            supersedes: ['sup-1'],
            retracted_message_uuids: ['ret-1'],
          })
        ),
        { variant: 'sdk', sendStatus: null }
      );
      expect(refusal.replacementEdges).toEqual([
        { targetUuid: 'sup-1', kind: 'superseded' },
        { targetUuid: 'ret-1', kind: 'retracted' },
      ]);

      const plain = decideMessageAdmission(
        normalizeMessageAdmissionInput(
          userMessage('u-plain', { retracted_message_uuids: ['ret-2'] })
        ),
        { variant: 'sdk', sendStatus: null }
      );
      expect(plain.replacementEdges).toEqual([]);
    });
  });

  describe('user variant: anchor is gated on consumed or failed send status', () => {
    const STATUSES: SendStatus[] = ['deferred', 'enqueued', 'submitted', 'consumed', 'failed'];

    test.each(STATUSES)('sendStatus %s', (sendStatus) => {
      const record = decideMessageAdmission(normalizeMessageAdmissionInput(userMessage('u-2')), {
        variant: 'user',
        sendStatus,
      });
      const settled = sendStatus === 'consumed' || sendStatus === 'failed';
      expect(record.isConversationAnchor).toBe(settled);
      expect(record.countsTowardsBadge).toBe(settled);
      expect(record.isRenderable).toBe(1);
      expect(record.sdkUuid).toBe('u-2');
    });

    test('the same message anchors on the sdk variant while deferred does not anchor on the user variant', () => {
      const input = normalizeMessageAdmissionInput(userMessage('u-contrast'));
      const sdkRecord = decideMessageAdmission(input, { variant: 'sdk', sendStatus: null });
      const deferredRecord = decideMessageAdmission(input, {
        variant: 'user',
        sendStatus: 'deferred',
      });
      expect(sdkRecord.isConversationAnchor).toBe(true);
      expect(deferredRecord.isConversationAnchor).toBe(false);
    });
  });

  describe('hyperneo_action variant: fixed-shape admission via the normalizer', () => {
    test('never anchors, counts toward the badge, and carries no edges', () => {
      const record = decideMessageAdmission(
        normalizeMessageAdmissionInput(actionMessage('act-1')),
        {
          variant: 'hyperneo_action',
          sendStatus: null,
        }
      );
      expect(record).toEqual({
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'act-1',
        replacementEdges: [],
      });
    });
  });

  describe('normalizeMessageAdmissionInput', () => {
    test('passes an SDKMessage through unchanged', () => {
      const message = userMessage('u-pass');
      expect(normalizeMessageAdmissionInput(message)).toEqual({ message });
    });

    test('maps the disjoint HyperNeoActionMessage onto the shared carrier', () => {
      expect(normalizeMessageAdmissionInput(actionMessage('act-2'))).toEqual({
        message: {
          type: 'hyperneo_action',
          subtype: 'sdk_resume_choice',
          uuid: 'act-2',
        },
      });
    });
  });
});

describe('decideMessageAdmission decision table', () => {
  function hiddenSystemMessage(subtype: string, uuid: string): SDKMessage {
    return asMsg({ type: 'system', subtype, uuid });
  }

  function refusalFallbackMessage(uuid: string): SDKMessage {
    return asMsg({
      type: 'system',
      subtype: 'model_refusal_fallback',
      uuid,
      supersedes: ['old-1'],
      retracted_message_uuids: ['old-2'],
    });
  }

  const cases = [
    {
      name: 'sdk renderable user message anchors and counts',
      input: userMessage('u-sdk'),
      options: { variant: 'sdk', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: true,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'u-sdk',
        replacementEdges: [],
      },
    },
    {
      name: 'sdk non-renderable user tool-result message counts but does not anchor',
      input: toolResultUserMessage('u-tool-sdk'),
      options: { variant: 'sdk', sendStatus: null } as const,
      expected: {
        isRenderable: 0,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'u-tool-sdk',
        replacementEdges: [],
      },
    },
    {
      name: 'sdk renderable assistant message counts and does not anchor',
      input: assistantMessage('a-sdk'),
      options: { variant: 'sdk', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'a-sdk',
        replacementEdges: [],
      },
    },
    {
      name: 'sdk subagent row carries parent tool use id and never counts',
      input: assistantMessage('a-sub', { parent_tool_use_id: 'tu-1' }),
      options: { variant: 'sdk', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: false,
        parentToolUseId: 'tu-1',
        sdkUuid: 'a-sub',
        replacementEdges: [],
      },
    },
    {
      name: 'sdk terminal result is terminal and counts',
      input: resultMessage('r-1'),
      options: { variant: 'sdk', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 1,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'r-1',
        replacementEdges: [],
      },
    },
    {
      name: 'sdk hidden system subtype is visible but does not count',
      input: hiddenSystemMessage('task_started', 'sys-hidden'),
      options: { variant: 'sdk', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: false,
        parentToolUseId: null,
        sdkUuid: 'sys-hidden',
        replacementEdges: [],
      },
    },
    {
      name: 'sdk thinking_tokens is visible but does not count',
      input: hiddenSystemMessage('thinking_tokens', 'sys-think'),
      options: { variant: 'sdk', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: false,
        parentToolUseId: null,
        sdkUuid: 'sys-think',
        replacementEdges: [],
      },
    },
    {
      name: 'sdk model_refusal_fallback carries superseded and retracted edges and counts',
      input: refusalFallbackMessage('sys-refusal'),
      options: { variant: 'sdk', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'sys-refusal',
        replacementEdges: [
          { targetUuid: 'old-1', kind: 'superseded' },
          { targetUuid: 'old-2', kind: 'retracted' },
        ],
      },
    },
    {
      name: 'user consumed renderable message anchors and counts',
      input: userMessage('u-consumed'),
      options: { variant: 'user', sendStatus: 'consumed' } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: true,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'u-consumed',
        replacementEdges: [],
      },
    },
    {
      name: 'user failed renderable message anchors and counts',
      input: userMessage('u-failed'),
      options: { variant: 'user', sendStatus: 'failed' } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: true,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'u-failed',
        replacementEdges: [],
      },
    },
    {
      name: 'user deferred renderable message does not anchor or count',
      input: userMessage('u-deferred'),
      options: { variant: 'user', sendStatus: 'deferred' } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: false,
        parentToolUseId: null,
        sdkUuid: 'u-deferred',
        replacementEdges: [],
      },
    },
    {
      name: 'user enqueued renderable message does not anchor or count',
      input: userMessage('u-enqueued'),
      options: { variant: 'user', sendStatus: 'enqueued' } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: false,
        parentToolUseId: null,
        sdkUuid: 'u-enqueued',
        replacementEdges: [],
      },
    },
    {
      name: 'user submitted renderable message does not anchor or count',
      input: userMessage('u-submitted'),
      options: { variant: 'user', sendStatus: 'submitted' } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: false,
        parentToolUseId: null,
        sdkUuid: 'u-submitted',
        replacementEdges: [],
      },
    },
    {
      name: 'user message with null sendStatus counts via default but does not anchor',
      input: userMessage('u-null'),
      options: { variant: 'user', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'u-null',
        replacementEdges: [],
      },
    },
    {
      name: 'user consumed non-renderable tool-result counts but does not anchor',
      input: toolResultUserMessage('u-tool-consumed'),
      options: { variant: 'user', sendStatus: 'consumed' } as const,
      expected: {
        isRenderable: 0,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'u-tool-consumed',
        replacementEdges: [],
      },
    },
    {
      name: 'user failed non-renderable tool-result counts but does not anchor',
      input: toolResultUserMessage('u-tool-failed'),
      options: { variant: 'user', sendStatus: 'failed' } as const,
      expected: {
        isRenderable: 0,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'u-tool-failed',
        replacementEdges: [],
      },
    },
    {
      name: 'user deferred non-renderable tool-result does not count',
      input: toolResultUserMessage('u-tool-deferred'),
      options: { variant: 'user', sendStatus: 'deferred' } as const,
      expected: {
        isRenderable: 0,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: false,
        parentToolUseId: null,
        sdkUuid: 'u-tool-deferred',
        replacementEdges: [],
      },
    },
    {
      name: 'hyperneo_action message counts and does not anchor',
      input: actionMessage('act-1'),
      options: { variant: 'hyperneo_action', sendStatus: null } as const,
      expected: {
        isRenderable: 1,
        isTerminal: 0,
        isConversationAnchor: false,
        countsTowardsBadge: true,
        parentToolUseId: null,
        sdkUuid: 'act-1',
        replacementEdges: [],
      },
    },
  ];

  test.each(cases.map((c) => [c.name, c] as const))('%s', (_label, c) => {
    const record = decideMessageAdmission(normalizeMessageAdmissionInput(c.input), c.options);
    expect(record).toMatchObject(c.expected);
  });
});
