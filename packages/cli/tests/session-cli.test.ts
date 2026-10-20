import { describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { planSessionCommand, resolveSender, runSessionCommand } from '../src/session-cli';

describe('hyperneo send and question', () => {
  test('the sender is the HyperNeo session first, then the Codex thread, then Claude Code', () => {
    expect(
      resolveSender({
        HYPERNEO_SESSION_ID: 's1',
        CODEX_THREAD_ID: 't1',
        CLAUDE_CODE_SESSION_ID: 'c1',
      })
    ).toBe('s1');
    expect(resolveSender({ CODEX_THREAD_ID: 't1', CLAUDE_CODE_SESSION_ID: 'c1' })).toBe(
      'codex-desktop:t1'
    );
    expect(resolveSender({ CLAUDE_CODE_SESSION_ID: 'c1' })).toBe('claude-code:c1');
  });

  test('with no sender variable it fails with a clear error and sends nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await runSessionCommand(['send', 'neo-root', 'hi'], { HYPERNEO_SESSION_DOOR: '/nowhere' })
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('hyperneo send: no sender'));
    error.mockRestore();
  });

  test('send joins the words into one message and question reads by id', () => {
    expect(planSessionCommand(['send', 'neo-root', 'Tests', 'pass.'], 's1')).toEqual({
      value: {
        name: 'message.send',
        input: {
          to: 'neo-root',
          text: 'Tests pass.',
        },
      },
    });
    expect(planSessionCommand(['question', 'q-7'], 's1')).toEqual({
      value: { name: 'neo.question.get', input: { questionId: 'q-7' } },
    });
    expect(planSessionCommand(['send', 'neo-root'], 's1')).toHaveProperty('reason');
  });
});
