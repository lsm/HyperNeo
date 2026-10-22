import { describe, expect, test } from 'bun:test';
import { neoIntakeMessage, neoRetryLocalTime } from '../../../../src/lib/neo/intake.ts';
import { neoLocalTimeLine } from '../../../../src/lib/neo/local-time.ts';

describe('neoLocalTimeLine', () => {
  test('is one short line in the local day and zone', () => {
    expect(neoLocalTimeLine(new Date('2026-10-19T01:10:00Z'), 'America/New_York')).toBe(
      '(local time: Sun 2026-10-18 21:10 EDT)'
    );
  });
});

describe('neoIntakeMessage', () => {
  const input = {
    sessionId: 'neo',
    requestId: '00000000-0000-4000-8000-000000000001',
    content: 'Ship it',
  };

  test('stores the local time before the quote fact and keeps the human words apart', () => {
    const message = neoIntakeMessage(
      { ...input, replyTo: { kind: 'message', id: 'm1', author: 'neo', excerpt: 'Ready?' } },
      'neo',
      null,
      '(local time: Sun 2026-10-18 21:10 EDT)'
    );
    expect(message.message.content).toEqual([
      { type: 'text', text: `[message id: ${input.requestId}]` },
      { type: 'text', text: '(local time: Sun 2026-10-18 21:10 EDT)' },
      { type: 'text', text: 'The human replied to the Neo message "Ready?":' },
      { type: 'text', text: 'Ship it' },
    ]);
    expect(message.humanContent).toEqual([{ type: 'text', text: 'Ship it' }]);
  });

  test.each([null, '(local time: Sun 2026-10-18 21:10 EDT)'])(
    'retrying a pre-id input preserves its stored text and metadata (%s)',
    (time) => {
      const initial = neoIntakeMessage(input, 'neo', null, time);
      const legacy = {
        ...initial,
        message: { ...initial.message, content: initial.message.content.slice(1) },
      };
      if (!time) delete legacy.humanContent;
      const retry = neoIntakeMessage(
        input,
        'neo',
        null,
        neoRetryLocalTime(legacy, 'fresh'),
        legacy
      );
      expect(retry).toEqual(legacy);
      expect(
        neoIntakeMessage({ ...input, content: 'Changed words' }, 'neo', null, time, legacy).message
          .content
      ).not.toEqual(legacy.message.content);
    }
  );

  test('a retry keeps the time its first attempt stored, and adds none to an older prompt', () => {
    const first = neoIntakeMessage(input, 'neo', null, '(local time: Sun 2026-10-18 21:10 EDT)');
    expect(neoRetryLocalTime(first, '(local time: Sun 2026-10-18 21:14 EDT)')).toBe(
      '(local time: Sun 2026-10-18 21:10 EDT)'
    );
    expect(neoRetryLocalTime(neoIntakeMessage(input), 'fresh')).toBeNull();
    expect(neoRetryLocalTime(undefined, 'fresh')).toBe('fresh');
  });
});
