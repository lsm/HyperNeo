import { describe, expect, test } from 'bun:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  createSendMessageRedirectHook,
  replyMessageBodyLength,
  withReplyLine,
} from '../../../../src/lib/messaging/session-reply';

const hook = createSendMessageRedirectHook((id) => id === 'neo:root');
const call = (to: string) =>
  hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'SendMessage',
      tool_input: { to, message: 'Done.' },
    } as unknown as HookInput,
    undefined,
    { signal: new AbortController().signal }
  );

describe('SendMessage to a HyperNeo session', () => {
  test('is refused with the exact message.send call that reaches it', async () => {
    const reason = (
      (await call('neo:root')) as { hookSpecificOutput: { permissionDecisionReason: string } }
    ).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('neo:root is a HyperNeo session; SendMessage cannot reach it.');
    expect(reason).toContain('"kind":"<kind>"');
    expect(reason).toContain('Choose kind done, blocked, question or failed');
    expect(reason).toContain(
      'mcp__hyperneo-operations__invoke {"name":"message.send","input":{"sessionId":"neo:root"'
    );
  });

  test('is refused for a session on another daemon too', async () => {
    expect(await call('daemon:imac::session:neo-root')).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  test('still reaches the session’s own agents and other peers', async () => {
    expect(await call('researcher')).toEqual({});
    expect(await call('uds:/tmp/cc-socks/1.sock')).toEqual({});
  });
});

describe('external CLI reply arguments', () => {
  test('quotes shell-sensitive sender IDs literally and keeps the note idempotent', () => {
    const from = `session:${encodeURIComponent("neo:root'$(false)")}`;
    const message = withReplyLine('Keep working.', from, 'cli');
    expect(message).toContain("hyperneo send 'neo:root'\\''$(false)' --kind <kind> \"<text>\"");
    expect(withReplyLine(message, from, 'cli')).toBe(message);
    expect(replyMessageBodyLength(message)).toBe('Keep working.'.length);
    expect(withReplyLine('Human.', 'chat', 'cli')).toBe('Human.');
    const incomplete = 'Human.\n\nReport progress, questions or blockers to Neo';
    expect(replyMessageBodyLength(incomplete)).toBe(incomplete.length);
  });

  test('a quoted template is not mistaken for an actionable reply line to the real sender', () => {
    const template =
      'Message Neo only at milestones (PR opened, merged or closed; blocked; a question; done; failed), with no acknowledgments and no progress pings. Use: hyperneo send <the sending Neo id> --kind <kind> "<text>" (not SendMessage). Choose kind done, blocked, question or failed; use done for a PR milestone. Keep working after you send.';
    const actual = withReplyLine(template, 'session:neo%3Aroot', 'cli');
    expect(actual).toEndWith(
      'hyperneo send neo:root --kind <kind> "<text>" (not SendMessage). Choose kind done, blocked, question or failed; use done for a PR milestone. Keep working after you send.'
    );
  });
});
