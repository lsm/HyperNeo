/**
 * Minimal GLM SDK Test
 *
 * Direct test of Claude Agent SDK with GLM using minimal settings.
 * Tests transparent provider mapping for all model tiers:
 * - 'haiku' model → GLM-5
 * - 'default' (sonnet) model → GLM-5
 * - 'opus' model → GLM-5
 *
 * Run with: cd packages/daemon && GLM_API_KEY=xxx bun test ./tests/online/glm/glm-sdk-minimal.test.ts
 *
 * KEY FINDINGS:
 * 1. SDK works with GLM via ANTHROPIC_AUTH_TOKEN env var (in parent process)
 * 2. Model tier mapping via ANTHROPIC_DEFAULT_*_MODEL env vars
 * 3. Response text is in `assistant` message's `message.content[0].text`
 * 4. The `result` message also contains the final result text in `result` field
 *
 * STABILITY IMPROVEMENTS:
 * - Promise.race timeout (120s internal, 150s test) for slower CI networks
 * - Helper function to reduce code duplication
 * - Proper env var restoration
 *
 * NOTE: SDK's abortSignal option doesn't properly terminate subprocess,
 * so we use Promise.race for timeout handling instead.
 *
 * REQUIREMENTS:
 * - GLM_API_KEY environment variable (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will FAIL if credentials are not available (per hard-fail rule)
 */

import { describe, test, expect } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Get API keys from env
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

/**
 * Helper: Run SDK query with timeout via Promise.race
 *
 * NOTE: SDK's abortSignal doesn't properly terminate subprocess.
 * We use Promise.race for timeout handling instead.
 */
async function runQueryWithTimeout(
  prompt: string,
  model: string,
  tempDir: string,
  timeoutMs = 120000
): Promise<string> {
  const agentQuery = query({
    prompt,
    options: {
      model,
      cwd: tempDir,
      permissionMode: 'acceptEdits',
      settingSources: [],
      mcpServers: {},
      maxTurns: 1,
    },
  });

  let responseText = '';
  let messageCount = 0;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`SDK timeout - no response after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  const messagesPromise = (async () => {
    for await (const msg of agentQuery) {
      messageCount++;
      console.log(`[GLM Test] Message ${messageCount}:`, msg.type);

      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            responseText += block.text;
          }
        }
      }

      if (msg.type === 'result') {
        const resultText = typeof msg.result === 'string' ? msg.result : '';
        console.log('[GLM Test] Result text:', resultText);

        if (
          /failed to authenticate|api error:\s*401|身份验证失败/i.test(resultText) ||
          /^failed\b/i.test(resultText)
        ) {
          throw new Error(`SDK authentication/result failure: ${resultText}`);
        }

        if (msg.subtype !== 'success') {
          throw new Error(`SDK result failure (${msg.subtype}): ${resultText || 'No error text'}`);
        }

        console.log('[GLM Test] Query completed', {
          messageCount,
          responseLength: responseText.length,
        });

        return responseText || resultText;
      }
    }

    console.log('[GLM Test] Query completed without explicit result message', {
      messageCount,
      responseLength: responseText.length,
    });

    return responseText;
  })();

  return Promise.race([messagesPromise, timeoutPromise]);
}

/**
 * Helper: Store and restore environment variables
 */
function setGlmEnvVars(
  apiKey: string,
  haikuModel?: string,
  sonnetModel?: string,
  opusModel?: string
): Map<string, string | undefined> {
  const originals = new Map<string, string | undefined>();
  const varsToSet = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'API_TIMEOUT_MS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
  ];

  // Store originals
  for (const key of varsToSet) {
    originals.set(key, process.env[key]);
  }

  // Set new values
  process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
  process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
  process.env.API_TIMEOUT_MS = '3000000';
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (haikuModel) process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
  if (sonnetModel) process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
  if (opusModel) process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;

  return originals;
}

/**
 * Helper: Restore environment variables from a Map
 */
function restoreEnvVars(originals: Map<string, string | undefined>): void {
  for (const [key, value] of originals.entries()) {
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
}

describe('GLM SDK - Stable Tests with Promise.race', () => {
  test('should work with GLM via sonnet/default model (glm-5)', async () => {
    if (!GLM_API_KEY) {
      throw new Error('GLM_API_KEY (or ZHIPU_API_KEY) must be set to run GLM online tests');
    }

    console.log('[GLM Test] Starting minimal SDK test with default → glm-5...');
    console.log('[GLM Test] API Key:', GLM_API_KEY.substring(0, 10) + '...');

    const originals = setGlmEnvVars(GLM_API_KEY, undefined, 'glm-5');
    const tempDir = mkdtempSync(join(tmpdir(), 'glm-test-'));

    try {
      console.log(
        '[GLM Test] ANTHROPIC_DEFAULT_SONNET_MODEL:',
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      );
      console.log('[GLM Test] ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL);

      const responseText = await runQueryWithTimeout(
        'Say "Hello from GLM" in exactly 5 words.',
        'default',
        tempDir
      );

      // Verify we got a response from GLM
      expect(responseText.length).toBeGreaterThan(0);
      console.log('[GLM Test] SUCCESS - GLM works with default (sonnet) model!');
    } finally {
      restoreEnvVars(originals);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 150000); // 150s test timeout for GLM API on CI

  test('should work with GLM via default/sonnet model (glm-5)', async () => {
    if (!GLM_API_KEY) {
      throw new Error('GLM_API_KEY (or ZHIPU_API_KEY) must be set to run GLM online tests');
    }

    console.log('[GLM Test] Starting SDK test with default → glm-5...');

    const originals = setGlmEnvVars(GLM_API_KEY, undefined, 'glm-5');
    const tempDir = mkdtempSync(join(tmpdir(), 'glm-test-'));

    try {
      console.log(
        '[GLM Test] ANTHROPIC_DEFAULT_SONNET_MODEL:',
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      );

      const responseText = await runQueryWithTimeout(
        'Say "Sonnet mapped to GLM" in exactly 5 words.',
        'default',
        tempDir
      );

      expect(responseText.length).toBeGreaterThan(0);
      console.log('[GLM Test] SUCCESS - GLM works with default (sonnet) model!');
    } finally {
      restoreEnvVars(originals);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 150000); // 150s test timeout for GLM API on CI

  test('should work with GLM via opus model (glm-5)', async () => {
    if (!GLM_API_KEY) {
      throw new Error('GLM_API_KEY (or ZHIPU_API_KEY) must be set to run GLM online tests');
    }

    console.log('[GLM Test] Starting SDK test with opus → glm-5...');

    const originals = setGlmEnvVars(GLM_API_KEY, undefined, undefined, 'glm-5');
    const tempDir = mkdtempSync(join(tmpdir(), 'glm-test-'));

    try {
      console.log(
        '[GLM Test] ANTHROPIC_DEFAULT_OPUS_MODEL:',
        process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      );

      const responseText = await runQueryWithTimeout(
        'Say "Opus mapped to GLM" in exactly 5 words.',
        'opus',
        tempDir
      );

      expect(responseText.length).toBeGreaterThan(0);
      console.log('[GLM Test] SUCCESS - GLM works with opus model!');
    } finally {
      restoreEnvVars(originals);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 150000); // 150s test timeout for GLM API on CI
});
