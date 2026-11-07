import { describe, expect, it } from 'vitest';
import {
  translateOapEvent,
  initialOapTranslatorState,
} from '../../../../src/lib/oap/oap-sdk-translator';

describe('translateOapEvent', () => {
  it('translates text and emits exactly one terminal result', () => {
    const state = initialOapTranslatorState('session-1');
    const text = translateOapEvent(state, {
      type: 'content.delta',
      id: 'event-1',
      payload: { part: { type: 'text', text: 'hello' } },
    });
    expect(text.messages[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    const completed = translateOapEvent(text.state, {
      type: 'run.completed',
      id: 'event-2',
      payload: { stop_reason: 'end_turn' },
    });
    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
    });
    expect(
      translateOapEvent(completed.state, { type: 'run.completed', id: 'event-3', payload: {} })
        .messages
    ).toEqual([]);
    expect(
      translateOapEvent(completed.state, {
        type: 'content.delta',
        id: 'event-4',
        payload: { part: { type: 'text', text: 'late' } },
      }).messages
    ).toEqual([]);
  });
  it('translates a failed run into an error result', () => {
    const result = translateOapEvent(initialOapTranslatorState('session-1'), {
      type: 'run.failed',
      id: 'event-5',
      payload: { error: { message: 'failed' } },
    });
    expect(result.messages[0]).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['failed'],
    });
  });
  it('preserves separate text deltas and drops unsupported parts', () => {
    const state = initialOapTranslatorState('session-1');
    const first = translateOapEvent(state, {
      type: 'content.delta',
      id: 'event-1',
      payload: { part: { type: 'text', text: 'A' } },
    });
    const second = translateOapEvent(first.state, {
      type: 'content.delta',
      id: 'event-2',
      payload: { part: { type: 'text', text: 'B' } },
    });
    expect(first.messages[0]).toMatchObject({ message: { content: [{ text: 'A' }] } });
    expect(second.messages[0]).toMatchObject({ message: { content: [{ text: 'B' }] } });
    expect(first.messages[0]?.uuid).not.toEqual(second.messages[0]?.uuid);
    expect(
      translateOapEvent(state, {
        type: 'content.delta',
        id: 'event-3',
        payload: { part: { type: 'image' } },
      }).messages
    ).toEqual([]);
    expect(state.terminal).toBe(false);
  });
  it('settles a cancelled run once with its reason', () => {
    const cancelled = translateOapEvent(initialOapTranslatorState('session-1'), {
      type: 'run.cancelled',
      id: 'event-7',
      payload: { reason: 'native turn interrupted' },
    });
    expect(cancelled.messages).toMatchObject([
      { type: 'result', is_error: true, errors: ['native turn interrupted'] },
    ]);
    expect(
      translateOapEvent(cancelled.state, { type: 'run.failed', id: 'event-8', payload: {} })
        .messages
    ).toEqual([]);
  });
});
