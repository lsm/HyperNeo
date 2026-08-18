import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import { waitForSystemInit } from '../../helpers/sdk-message-helpers';
import { GlmProvider } from '../../../src/lib/providers/glm-provider';
import { MinimaxProvider } from '../../../src/lib/providers/minimax-provider';
import type { DaemonAppContext } from '../../../src/app';
import { getSDKSessionFilePath } from '../../../src/lib/sdk-session-file-manager';
import { existsSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';

const TMP_DIR = realpathSync(process.env.TMPDIR || '/tmp');

function requireCredentialsOrFail(): void {
  const hasGlm = new GlmProvider().isAvailable();
  const hasMinimax = new MinimaxProvider().isAvailable();
  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);

  const missing: string[] = [];
  if (!hasGlm) missing.push('GLM_API_KEY or ZHIPU_API_KEY');
  if (!hasMinimax) missing.push('MINIMAX_API_KEY');
  if (!hasAnthropic) missing.push('ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN');

  if (missing.length > 0) {
    throw new Error(
      `Thinking block signature tests require GLM, MiniMax, and Anthropic credentials. Missing: ${missing.join(', ')}`
    );
  }
}

function getAgentSdkSessionId(
  daemon: DaemonServerContext & { daemonContext: DaemonAppContext },
  sessionId: string
): string | undefined {
  const agentSession = daemon.daemonContext.sessionManager.getSession(sessionId);
  return agentSession?.session.sdkSessionId;
}

async function waitForSDKSessionEstablished(
  daemon: DaemonServerContext & { daemonContext: DaemonAppContext },
  sessionId: string,
  timeout = 30000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const sdkId = getAgentSdkSessionId(daemon, sessionId);
    if (sdkId) return sdkId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`SDK session not established within ${timeout}ms.`);
}

async function waitForJSONLFlush(filePath: string, maxAttempts = 20): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (existsSync(filePath)) {
      const c = readFileSync(filePath, 'utf-8');
      if (c.includes('"type":"assistant"')) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function extractThinkingBlockSignatures(
  filePath: string,
  label: string
): Array<{ sigLen: number; sigPrefix: string }> {
  const results: Array<{ sigLen: number; sigPrefix: string }> = [];
  if (!existsSync(filePath)) return results;

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as {
        type?: string;
        message?: {
          content?: Array<{ type: string; signature?: string; thinking?: string }>;
        };
      };
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'thinking') {
          const sig = block.signature;
          const sigLen = typeof sig === 'string' ? sig.length : -1;
          const sigPrefix = typeof sig === 'string' ? sig.slice(0, 80) : String(sig);
          // biome-ignore lint/suspicious/noConsole: test diagnostic
          console.log(
            `[${label}] THINKING BLOCK: sig_len=${sigLen}, ` +
              `sig_value=${JSON.stringify(sigPrefix)}`
          );
          results.push({ sigLen, sigPrefix });
        }
      }
    } catch {
      // skip
    }
  }

  if (results.length === 0) {
    // biome-ignore lint/suspicious/noConsole: test diagnostic
    console.log(`[${label}] No thinking blocks found in session file`);
  }

  return results;
}

describe('Thinking Block Signatures', () => {
  let daemon: DaemonServerContext & { daemonContext: DaemonAppContext };

  beforeEach(async () => {
    requireCredentialsOrFail();
    daemon = (await createDaemonServer()) as DaemonServerContext & {
      daemonContext: DaemonAppContext;
    };
  }, 30000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 20000);

  test('compare thinking block signatures: GLM vs MiniMax vs Anthropic', async () => {
    const providers = [
      { label: 'GLM', model: 'sonnet', provider: 'glm' },
      { label: 'MiniMax', model: 'MiniMax-M2.7', provider: 'minimax' },
      { label: 'Anthropic', model: 'sonnet', provider: 'anthropic' },
    ] as const;

    for (const { label, model, provider } of providers) {
      const workspacePath = `${TMP_DIR}/test-sig-compare-${label.toLowerCase()}-${Date.now()}`;
      mkdirSync(workspacePath, { recursive: true });

      const { sessionId } = (await daemon.messageHub.request('session.create', {
        workspacePath,
        title: `Sig Compare ${label}`,
        config: { model, provider, permissionMode: 'acceptEdits', thinkingLevel: 'think8k' },
      })) as { sessionId: string };
      daemon.trackSession(sessionId);

      await sendMessage(
        daemon,
        sessionId,
        'What is 17 * 23? Show your reasoning step by step, then give the answer.'
      );
      await waitForIdle(daemon, sessionId, 60000);

      const sdkId = await waitForSDKSessionEstablished(daemon, sessionId);
      expect(sdkId).toBeTruthy();

      const filePath = getSDKSessionFilePath(workspacePath, sdkId);
      await waitForJSONLFlush(filePath);
      extractThinkingBlockSignatures(filePath, label);
    }
  }, 180000);

  test('MiniMax (think8k) → Anthropic: resume with thinking block stripping', async () => {
    const workspacePath = `${TMP_DIR}/test-minimax-think-to-anthropic-${Date.now()}`;
    mkdirSync(workspacePath, { recursive: true });
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      title: 'MiniMax think8k → Anthropic',
      config: {
        model: 'MiniMax-M2.7',
        provider: 'minimax',
        permissionMode: 'acceptEdits',
        thinkingLevel: 'think8k',
      },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    await sendMessage(daemon, sessionId, 'What is 17 * 23? Show your reasoning.');
    await waitForIdle(daemon, sessionId, 60000);

    const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
    expect(sdkIdBefore).toBeTruthy();

    const filePathBefore = getSDKSessionFilePath(workspacePath, sdkIdBefore);
    await waitForJSONLFlush(filePathBefore);
    extractThinkingBlockSignatures(filePathBefore, 'MiniMax BEFORE switch');

    const switchResult = (await daemon.messageHub.request('session.model.switch', {
      sessionId,
      model: 'sonnet',
      provider: 'anthropic',
    })) as { success: boolean; model: string };
    expect(switchResult.success).toBe(true);

    await waitForIdle(daemon, sessionId);

    const systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'Say "world" in one word.');
    const systemInit = await systemInitPromise;
    await waitForIdle(daemon, sessionId);

    expect(systemInit.type).toBe('system');
    expect(systemInit.subtype).toBe('init');

    const sdkIdAfter = getAgentSdkSessionId(daemon, sessionId);
    expect(sdkIdAfter).toBeTruthy();

    if (sdkIdAfter === sdkIdBefore) {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log('✓ sdkSessionId PRESERVED — resume worked after thinking block stripping');
    } else {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(`✗ sdkSessionId CHANGED — Before: ${sdkIdBefore}, After: ${sdkIdAfter}`);
    }
  }, 120000);

  test('GLM (think8k) → Anthropic: resume with thinking block stripping', async () => {
    const workspacePath = `${TMP_DIR}/test-glm-think-to-anthropic-${Date.now()}`;
    mkdirSync(workspacePath, { recursive: true });
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      title: 'GLM think8k → Anthropic',
      config: {
        model: 'sonnet',
        provider: 'glm',
        permissionMode: 'acceptEdits',
        thinkingLevel: 'think8k',
      },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    await sendMessage(daemon, sessionId, 'What is 17 * 23? Show your reasoning.');
    await waitForIdle(daemon, sessionId, 60000);

    const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
    expect(sdkIdBefore).toBeTruthy();

    const filePathBefore = getSDKSessionFilePath(workspacePath, sdkIdBefore);
    await waitForJSONLFlush(filePathBefore);
    extractThinkingBlockSignatures(filePathBefore, 'GLM BEFORE switch');

    const switchResult = (await daemon.messageHub.request('session.model.switch', {
      sessionId,
      model: 'sonnet',
      provider: 'anthropic',
    })) as { success: boolean; model: string };
    expect(switchResult.success).toBe(true);

    await waitForIdle(daemon, sessionId);

    const systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'Say "world" in one word.');
    const systemInit = await systemInitPromise;
    await waitForIdle(daemon, sessionId);

    expect(systemInit.type).toBe('system');
    expect(systemInit.subtype).toBe('init');

    const sdkIdAfter = getAgentSdkSessionId(daemon, sessionId);
    expect(sdkIdAfter).toBeTruthy();

    if (sdkIdAfter === sdkIdBefore) {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log('✓ sdkSessionId PRESERVED — resume worked after thinking block stripping');
    } else {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(`✗ sdkSessionId CHANGED — Before: ${sdkIdBefore}, After: ${sdkIdAfter}`);
    }
  }, 120000);
});
