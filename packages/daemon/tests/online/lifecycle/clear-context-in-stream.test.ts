/**
 * Online regression: the SDK's `/clear` command clears the model's context
 * WITHIN a streaming-input query (the mode `resetContextPerTurn` runs in).
 *
 * `AgentSession.clearConversationContext()` issues `/clear` by enqueuing it as
 * an internal message into the persistent streaming query's generator, ahead of
 * the triggering handoff. This test guards the SDK assumption that contract
 * rests on: that yielding `/clear` mid-stream (a) clears context for the next
 * yielded message and (b) rotates the SDK session id, which our
 * `handleSystemInit` then recaptures.
 *
 * The unit tests cover clearConversationContext's enqueue/cost/trace logic; this
 * test covers the SDK behavior those unit tests mock out. A one-shot `query()`
 * can't exercise this (the docs: "/clear ... for one-shot query() calls has no
 * practical effect"), so this drives a streaming-input generator directly.
 *
 * MODES:
 * - Real API (default): requires CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN
 *   / ANTHROPIC_API_KEY. Hard-fails if none are set (per the online-test contract).
 * - Dev Proxy: set HYPERNEO_USE_DEV_PROXY=1 for offline mocked responses.
 *
 * Run: cd packages/daemon && bun test ./tests/online/lifecycle/clear-context-in-stream.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AUTH =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY;

// An unguessable codeword so the post-clear probe can't accidentally reproduce it.
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
      // /clear emits its own result; wait for it before probing.
      try {
        await waitForResults(2, 60_000);
      } catch {
        // Some SDK versions may not emit a result for /clear — proceed anyway.
      }

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

    // /clear cleared context: the probe must NOT reproduce the unguessable codeword.
    expect(probeText.toLowerCase()).not.toContain(CODEWORD.toLowerCase());
    // /clear rotated the SDK session id (≥2 distinct inits: pre- and post-clear).
    expect(new Set(sessionIds).size).toBeGreaterThanOrEqual(2);
  }, 240_000);
});
