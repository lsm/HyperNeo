import { describe, expect, test } from 'bun:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { createSendMessageRedirectHook } from '../../../../src/lib/messaging/session-reply';

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
