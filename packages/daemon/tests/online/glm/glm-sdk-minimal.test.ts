import { describe, test, expect } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

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

  for (const key of varsToSet) {
    originals.set(key, process.env[key]);
  }

  process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
  process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
  process.env.API_TIMEOUT_MS = '3000000';
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (haikuModel) process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
  if (sonnetModel) process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
  if (opusModel) process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;

  return originals;
}

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

      expect(responseText.length).toBeGreaterThan(0);
      console.log('[GLM Test] SUCCESS - GLM works with default (sonnet) model!');
    } finally {
      restoreEnvVars(originals);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 150000);

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
  }, 150000);

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
  }, 150000);
});
