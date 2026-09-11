import { describe, expect, test } from 'bun:test';
import type { PersistPromptArgs } from '../../../../src/lib/agent/message-delivery-outbox';
import {
  assembleAdmissionPlan,
  planMailboxAdmission,
  projectAdmissionDelivery,
  projectAdmissionMessage,
  type SessionMailboxEntry,
} from '../../../../src/lib/mailbox/admission-plan';
import { DEFAULT_MAILBOX_ENTRY_POLICY } from '../../../../src/lib/mailbox/entry';

const entry: SessionMailboxEntry = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  to: { kind: 'session', sessionId: 'session-1' },
  origin: 'chat',
  message: {
    type: 'user',
    message: { content: 'hello' },
    parent_tool_use_id: null,
    priority: 'next',
    referenceMetadata: {
      '@ref{task:t1}': { type: 'task', id: 't1', displayText: 'Task one' },
    },
  },
  status: 'enqueued',
  policy: DEFAULT_MAILBOX_ENTRY_POLICY,
  deliveryMode: 'immediate',
};
const uuid = 'mbox-8eac53b3-f14d-71fe-51a6-3af287b39e99';

describe('mailbox admission stages', () => {
  test('message projection preserves metadata and derives a stable UUID', () => {
    expect(projectAdmissionMessage(entry, false)).toEqual({
      ...entry.message,
      uuid,
      session_id: 'session-1',
    });
    expect(projectAdmissionMessage({ ...entry, messageUuid: 'explicit-id' }, true)).toEqual({
      ...entry.message,
      uuid: 'explicit-id',
      session_id: 'session-1',
      isSynthetic: true,
    });
  });

  test.each(['chat', 'space_inject', 'space_agent', 'long_term_agent', 'recovery', 'future'])(
    'delivery projection maps %s and preserves rowid presence',
    (origin) => {
      const source = { ...entry, origin };
      const expected = {
        origin: origin === 'future' ? 'space_inject' : origin,
        parentToolUseId: null,
        admittedAt: 1469922850259,
      };
      expect(projectAdmissionDelivery(source, undefined)).toEqual(expected);
      expect(projectAdmissionDelivery(source, 0)).toEqual({ ...expected, admissionRowid: 0 });
      expect(projectAdmissionDelivery(source, 42)).toEqual({ ...expected, admissionRowid: 42 });
    }
  );

  test('assembly includes hold and provenance only when required', () => {
    const message = projectAdmissionMessage(entry, false);
    const delivery = projectAdmissionDelivery(entry, undefined);
    expect(assembleAdmissionPlan(entry, false, message, delivery)).toEqual({
      sessionId: 'session-1',
      message,
      delivery,
    });
    expect(
      assembleAdmissionPlan({ ...entry, deliveryMode: 'defer' }, true, message, delivery)
    ).toEqual({
      sessionId: 'session-1',
      message,
      delivery,
      origin: 'system',
      hold: 'manual',
      materializeOnly: true,
    });
  });
});

describe('planMailboxAdmission', () => {
  test.each([
    ['chat', 'system', false],
    ['chat', 'task', false],
    ['space_agent', 'human', false],
    ['future', 'human', false],
    ['future', 'system', true],
  ] as const)(
    '%s with %s input preserves provenance in both modes',
    (origin, inputKind, synthetic) => {
      for (const deliveryMode of ['immediate', 'defer'] as const) {
        const source = {
          ...entry,
          origin,
          deliveryMode,
          message: { ...entry.message, inputKind },
        };
        const before = structuredClone(source);
        const plan = planMailboxAdmission(source, 42);
        const prompt: Omit<PersistPromptArgs, 'db' | 'sdkMessageRepo' | 'jobQueue'> = plan;
        expect(prompt).toEqual({
          sessionId: 'session-1',
          message: {
            ...source.message,
            uuid,
            session_id: 'session-1',
            ...(synthetic ? { isSynthetic: true } : {}),
          },
          ...(synthetic ? { origin: 'system' } : {}),
          ...(deliveryMode === 'defer' ? { hold: 'manual', materializeOnly: true } : {}),
          delivery: {
            origin: origin === 'future' ? 'space_inject' : origin,
            parentToolUseId: null,
            admittedAt: 1469922850259,
            admissionRowid: 42,
          },
        });
        expect(planMailboxAdmission(source, 42)).toEqual(plan);
        expect(source).toEqual(before);
      }
    }
  );

  test('explicit UUID and omitted rowid survive the complete pipeline', () => {
    const plan = planMailboxAdmission({ ...entry, messageUuid: 'explicit-id' });
    expect(plan.message.uuid).toBe('explicit-id');
    expect(plan.delivery).not.toHaveProperty('admissionRowid');
  });
});
