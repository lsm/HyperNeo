import { describe, expect, test } from 'bun:test';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { neoIntakeMessage, neoRetryLocalTime } from '../../../../src/lib/neo/intake.ts';
import { neoLocalNow, neoLocalTimeLine } from '../../../../src/lib/neo/local-time.ts';
import { restrictNeoQuery } from '../../../../src/lib/neo/session-policy.ts';

describe('neoLocalNow', () => {
  test('names the local day when UTC has already rolled over', () => {
    const line = neoLocalNow(new Date('2026-10-16T02:15:00Z'), 'America/New_York');
    expect(line).toContain('Thursday 2026-10-15 22:15 (America/New_York, GMT-04:00)');
    expect(line).toContain('timestamps in tool results are UTC');
  });
});

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
      { type: 'text', text: '(local time: Sun 2026-10-18 21:10 EDT)' },
      { type: 'text', text: 'The human replied to the Neo message "Ready?":' },
      { type: 'text', text: 'Ship it' },
    ]);
    expect(message.humanContent).toEqual([{ type: 'text', text: 'Ship it' }]);
  });

  test('a retry keeps the time its first attempt stored, and adds none to an older prompt', () => {
    const first = neoIntakeMessage(input, 'neo', null, '(local time: Sun 2026-10-18 21:10 EDT)');
    expect(neoRetryLocalTime(first, '(local time: Sun 2026-10-18 21:14 EDT)')).toBe(
      '(local time: Sun 2026-10-18 21:10 EDT)'
    );
    expect(neoRetryLocalTime(neoIntakeMessage(input), 'fresh')).toBeNull();
    expect(neoRetryLocalTime(undefined, 'fresh')).toBe('fresh');
  });
});

describe('restrictNeoQuery', () => {
  test("gives every Neo turn the human's local time", async () => {
    const options: Options = {};
    restrictNeoQuery(options, null);
    const [hook] = options.hooks?.UserPromptSubmit?.[0]?.hooks ?? [];
    const output = await (hook as HookCallback)({} as never, undefined, {
      signal: new AbortController().signal,
    });
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: expect.stringContaining("The human's local time is"),
      },
    });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(
      (output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
        .additionalContext
    ).toContain(`(${zone}, `);
  });
});
