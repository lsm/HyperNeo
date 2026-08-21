import { describe, expect, test } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AUTH =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY;

const CODEWORD = `ZEXQWB-${Date.now().toString(36)}`;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('SDK /clear in streaming-input mode', () => {
  test('clears context for the next yielded message and rotates the session id', async () => {
    if (!AUTH) {
      throw new Error(
        'CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY must be set ' +
          'to run the /clear online test'
      );
    }

    const cwd = mkdtempSync(join(tmpdir(), 'clear-in-stream-'));
    let resultsSeen = 0;
    let resultSignal = deferred<void>();
    const bumpResults = () => {
      resultsSeen++;
      resultSignal.resolve();
      resultSignal = deferred<void>();
    };
    const waitForResults = async (n: number, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (resultsSeen < n) {
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for result #${n} (saw ${resultsSeen})`);
        }
        await Promise.race([resultSignal.promise, new Promise((r) => setTimeout(r, 500))]);
      }
    };

    const userMsg = (text: string) => ({
      type: 'user' as const,
      parent_tool_use_id: null,
      message: { role: 'user' as const, content: text },
    });

    async function* promptStream() {
      yield userMsg(`Memory test. Remember this codeword: ${CODEWORD}. Reply with exactly: OK.`);
      await waitForResults(1, 90_000);

      yield userMsg('/clear');
      try {
        await waitForResults(2, 60_000);
      } catch {}

      yield userMsg(
        'What codeword did I ask you to remember earlier? Reply with ONLY the codeword, ' +
          'or "unknown" if you do not have it.'
      );
    }

    const sessionIds: string[] = [];
    let probeText = '';
    try {
      const q = query({
        prompt: promptStream(),
        options: { cwd, allowedTools: [], maxTurns: 3 },
      });

      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          sessionIds.push(msg.session_id);
        } else if (msg.type === 'assistant') {
          const txt = (msg.message.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(' ');
          if (txt.trim()) probeText = txt;
        } else if (msg.type === 'result') {
          bumpResults();
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(probeText.toLowerCase()).not.toContain(CODEWORD.toLowerCase());
    expect(new Set(sessionIds).size).toBeGreaterThanOrEqual(2);
  }, 240_000);
});
