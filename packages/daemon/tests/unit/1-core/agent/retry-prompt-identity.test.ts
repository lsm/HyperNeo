import { describe, expect, test } from 'bun:test';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import { RetryPromptIdentity } from '../../../../src/lib/agent/retry-prompt-identity.ts';

describe('RetryPromptIdentity', () => {
  test('gives retries fresh SDK transport IDs while preserving their durable input identity and content', () => {
    const ids = new RetryPromptIdentity();
    const input = {
      type: 'user',
      uuid: crypto.randomUUID(),
      session_id: 'fictional',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Original human input' },
    } as SDKUserMessage;
    expect(ids.incoming(input)).toBe(input);
    expect(ids.outgoing(input)).toBe(input);
    ids.retry(input.uuid!);
    const wire = ids.outgoing(input);
    expect(wire.uuid).not.toBe(input.uuid);
    expect(wire.message).toEqual(input.message);
    expect(ids.incoming(wire)).toEqual(input);
    const reply = {
      type: 'result',
      uuid: crypto.randomUUID(),
      user_message_uuid: wire.uuid,
      user_message_uuids: [wire.uuid, 'other'],
    } as unknown as SDKMessage;
    expect(ids.incoming(reply)).toEqual({
      ...reply,
      user_message_uuid: input.uuid,
      user_message_uuids: [input.uuid, 'other'],
    });
    ids.retry(input.uuid!);
    expect(ids.outgoing(input).uuid).not.toBe(wire.uuid);
    expect(ids.outgoing(input)).toBe(input);
  });
  test('coordinator deliveries keep durable attribution but use a fresh identity on every SDK attempt', () => {
    const input = {
      type: 'user',
      uuid: crypto.randomUUID(),
      session_id: 'neo:synthetic',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Recovered human input' },
    } as SDKUserMessage;
    const first = new RetryPromptIdentity();
    const wire = first.outgoing(input, true);
    expect(wire.uuid).not.toBe(input.uuid);
    expect(first.incoming(wire)).toEqual(input);
    const restarted = new RetryPromptIdentity();
    const replay = restarted.outgoing(input, true);
    expect(replay.uuid).not.toBe(wire.uuid);
    expect(replay.uuid).not.toBe(input.uuid);
    expect(restarted.incoming(replay)).toEqual(input);
    const steering = restarted.outgoing({ ...input, uuid: crypto.randomUUID() }, true);
    expect(steering.uuid).not.toBe(replay.uuid);
    restarted.retry(input.uuid!);
    restarted.outgoing(input, true);
    expect(restarted.outgoing(input)).toBe(input);
  });
  test('releases completed-turn identities without losing a queued input or cloning unrelated messages', () => {
    const ids = new RetryPromptIdentity();
    const input = {
      type: 'user',
      uuid: crypto.randomUUID(),
      session_id: 'neo:synthetic',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Queued synthetic input' },
    } as SDKUserMessage;
    const queued = ids.outgoing(input, true);
    const unrelated = { type: 'system', subtype: 'init' } as SDKMessage;
    for (let turn = 0; turn < 200; turn++) {
      const durable = { ...input, uuid: crypto.randomUUID() };
      const wire = ids.outgoing(durable, true);
      expect(ids.incoming(wire)).toEqual(durable);
      const result = {
        type: 'result',
        user_message_uuid: wire.uuid,
        user_message_uuids: [wire.uuid],
      } as unknown as SDKMessage;
      expect(ids.incoming(result)).toEqual({
        ...result,
        user_message_uuid: durable.uuid,
        user_message_uuids: [durable.uuid],
      });
      expect(ids.incoming(wire)).toBe(wire);
      expect(ids.incoming(queued)).toEqual(input);
    }
    expect(
      ids.incoming({ type: 'result', user_message_uuid: queued.uuid } as unknown as SDKMessage)
    ).toEqual({ type: 'result', user_message_uuid: input.uuid });
    expect(ids.incoming(queued)).toBe(queued);
    expect(ids.incoming(unrelated)).toBe(unrelated);
  });
});
