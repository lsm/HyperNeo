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
});
