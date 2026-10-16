import { describe, expect, test } from 'bun:test';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { neoLocalNow } from '../../../../src/lib/neo/local-time.ts';
import { restrictNeoQuery } from '../../../../src/lib/neo/session-policy.ts';

describe('neoLocalNow', () => {
  test('names the local day when UTC has already rolled over', () => {
    const line = neoLocalNow(new Date('2026-10-16T02:15:00Z'), 'America/New_York');
    expect(line).toContain('Thursday 2026-10-15 22:15 (America/New_York, GMT-04:00)');
    expect(line).toContain('timestamps in tool results are UTC');
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
