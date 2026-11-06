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
});
