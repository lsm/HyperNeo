/**
 * GLM → Anthropic Resume Test
 *
 * Focused test to investigate whether SDK session resume works when
 * switching from GLM (proxy provider, SDK model 'default') to
 * Anthropic (native provider, SDK model 'opus'/'sonnet').
 *
 * The hypothesis: the SDK model ID changes from 'default' to 'opus'
 * during the switch, and the SDK subprocess may not handle the model
 * mismatch during resume — causing a startup timeout.
 *
 * REQUIREMENTS:
 * - GLM_API_KEY or ZHIPU_API_KEY must be set
 * - ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN must be set
 * - Makes real API calls (costs money)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import { waitForSystemInit } from '../../helpers/sdk-message-helpers';
import { GlmProvider } from '../../../src/lib/providers/glm-provider';
import { MinimaxProvider } from '../../../src/lib/providers/minimax-provider';
import type { DaemonAppContext } from '../../../src/app';
import { getSDKSessionFilePath } from '../../../src/lib/sdk-session-file-manager';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Use realpath to resolve macOS symlinks (/var → /private/var).
// The SDK subprocess resolves CWD via realpath, so our path must match.
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
      `Cross-provider resume tests require GLM, MiniMax, and Anthropic credentials. Missing: ${missing.join(', ')}`
    );
  }
}

/**
 * Dump thinking blocks from a JSONL session file for diagnostic comparison.
 */
function dumpThinkingBlocks(workspacePath: string, sdkSessionId: string, label: string): void {
  const filePath = getSDKSessionFilePath(workspacePath, sdkSessionId);
  if (!existsSync(filePath)) {
    // biome-ignore lint/suspicious/noConsole: test diagnostic
    console.log(`[${label}] Session file not found: ${filePath}`);
    return;
  }
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  let found = 0;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as {
        type: string;
        message?: { content?: Array<{ type: string; signature?: string; thinking?: string }> };
      };
      const blocks = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'thinking') {
          found++;
          const sig = block.signature ?? 'MISSING';
          const sigLen = typeof sig === 'string' ? sig.length : -1;
          // biome-ignore lint/suspicious/noConsole: test diagnostic
          console.log(
            `[${label}] thinking block #${found}: signature length=${sigLen}, ` +
              `signature prefix=${JSON.stringify(typeof sig === 'string' ? sig.slice(0, 40) : sig)}`
          );
        }
      }
    } catch {
      // skip unparseable lines
    }
  }
  if (found === 0) {
    // biome-ignore lint/suspicious/noConsole: test diagnostic
    console.log(`[${label}] No thinking blocks found in session file`);
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

// Skipped: all tests send real messages across providers — too slow and flaky in CI
describe.skip('GLM → Anthropic Resume Investigation', () => {
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

  /**
   * Test 1: Baseline — verify GLM session works and sdkSessionId is captured
   */
  test('baseline: GLM session starts and captures sdkSessionId', async () => {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-glm-baseline-${Date.now()}`,
      title: 'GLM Baseline',
      config: { model: 'sonnet', provider: 'glm' },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
    await waitForIdle(daemon, sessionId);

    const sdkId = await waitForSDKSessionEstablished(daemon, sessionId);
    expect(sdkId).toBeTruthy();
  }, 120000);

  /**
   * Test 2: Baseline — verify Anthropic session works
   */
  test('baseline: Anthropic session starts and captures sdkSessionId', async () => {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-anthropic-baseline-${Date.now()}`,
      title: 'Anthropic Baseline',
      config: { model: 'sonnet', provider: 'anthropic' },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
    await waitForIdle(daemon, sessionId);

    const sdkId = await waitForSDKSessionEstablished(daemon, sessionId);
    expect(sdkId).toBeTruthy();
  }, 120000);

  /**
   * Test 3: THE KEY TEST — GLM → Anthropic switch with message after switch
   *
   * This reproduces the reported issue:
   * 1. Create GLM session, send message, establish sdkSessionId
   * 2. Switch to Anthropic (sonnet — cheapest)
   * 3. Send a message — does it work or timeout?
   *
   * Expected behavior (desired): message works on first try
   * Current behavior (bug): startup timeout, user must resend
   */
  test('GLM → Anthropic sonnet: send message after switch', async () => {
    const workspacePath = `${TMP_DIR}/test-glm-to-anthropic-${Date.now()}`;
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      title: 'GLM→Anthropic Resume',
      config: {
        model: 'sonnet',
        provider: 'glm',
        permissionMode: 'acceptEdits',
      },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    // Phase 1: Establish GLM session with a message
    await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
    await waitForIdle(daemon, sessionId);

    const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
    expect(sdkIdBefore).toBeTruthy();

    // Diagnostic: check session file exists before switch
    const filePathBefore = getSDKSessionFilePath(workspacePath, sdkIdBefore);
    const fileExistsBefore = existsSync(filePathBefore);
    // biome-ignore lint/suspicious/noConsole: test diagnostic
    console.log(`Before switch: session file exists=${fileExistsBefore}, path=${filePathBefore}`);

    // Also check the SDK projects dir
    const projectKey = workspacePath.replace(/[/.]/g, '-');
    const projectDir = join(homedir(), '.claude', 'projects', projectKey);
    try {
      const files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(
        `SDK project dir ${projectDir}: ${files.length} jsonl files: ${files.join(', ')}`
      );
    } catch {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(`SDK project dir ${projectDir}: does not exist or not readable`);
    }

    // Phase 2: Switch to Anthropic sonnet
    const switchResult = (await daemon.messageHub.request('session.model.switch', {
      sessionId,
      model: 'sonnet',
      provider: 'anthropic',
    })) as { success: boolean; model: string };
    expect(switchResult.success).toBe(true);

    // Dump thinking blocks from GLM session BEFORE switch
    dumpThinkingBlocks(workspacePath, sdkIdBefore, 'GLM→Anthropic BEFORE switch');

    // Diagnostic: check session file AFTER switch (before any message)
    const fileExistsAfterSwitch = existsSync(filePathBefore);
    // biome-ignore lint/suspicious/noConsole: test diagnostic
    console.log(`After switch: session file exists=${fileExistsAfterSwitch}`);
    try {
      const filesAfter = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(`After switch: ${filesAfter.length} jsonl files: ${filesAfter.join(', ')}`);
    } catch {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(`After switch: project dir not readable`);
    }

    // Wait for the restart to settle
    await waitForIdle(daemon, sessionId);

    // Phase 3: Send message on Anthropic — this is where the timeout occurs
    const systemInitPromise = waitForSystemInit(daemon, sessionId);
    await sendMessage(daemon, sessionId, 'Say "world" in one word.');
    const systemInit = await systemInitPromise;
    await waitForIdle(daemon, sessionId);

    // Verify system:init arrived (no timeout)
    expect(systemInit.type).toBe('system');
    expect(systemInit.subtype).toBe('init');

    // Check sdkSessionId — is it the same (resume worked) or different (new session)?
    const sdkIdAfter = getAgentSdkSessionId(daemon, sessionId);
    expect(sdkIdAfter).toBeTruthy();

    // Log whether resume preserved the ID or a new one was created
    if (sdkIdAfter === sdkIdBefore) {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log('✓ sdkSessionId PRESERVED — resume worked across GLM→Anthropic');
    } else {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(
        `✗ sdkSessionId CHANGED — resume failed. Before: ${sdkIdBefore}, After: ${sdkIdAfter}`
      );
    }
  }, 300000);

  /**
   * Test 4: GLM → Anthropic opus (the exact scenario from the bug report)
   */
  test('GLM → Anthropic opus: send message after switch', async () => {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-glm-to-opus-${Date.now()}`,
      title: 'GLM→Opus Resume',
      config: {
        model: 'sonnet',
        provider: 'glm',
        permissionMode: 'acceptEdits',
      },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    // Phase 1: Establish GLM session
    await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
    await waitForIdle(daemon, sessionId);

    const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
    expect(sdkIdBefore).toBeTruthy();

    // Phase 2: Switch to Anthropic opus (the reported failing case)
    const switchResult = (await daemon.messageHub.request('session.model.switch', {
      sessionId,
      model: 'opus',
      provider: 'anthropic',
    })) as { success: boolean; model: string };
    expect(switchResult.success).toBe(true);

    // Wait for restart to settle
    await waitForIdle(daemon, sessionId);

    // Phase 3: Send message on opus
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
      console.log('✓ sdkSessionId PRESERVED — resume worked for GLM→Opus');
    } else {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(
        `✗ sdkSessionId CHANGED for GLM→Opus. Before: ${sdkIdBefore}, After: ${sdkIdAfter}`
      );
    }
  }, 300000);

  /**
   * Test 5: Anthropic → GLM (reverse direction)
   * Control test — does switching FROM Anthropic TO GLM also have issues?
   */
  test('Anthropic sonnet → GLM: send message after switch', async () => {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-anthropic-to-glm-${Date.now()}`,
      title: 'Anthropic→GLM Resume',
      config: {
        model: 'sonnet',
        provider: 'anthropic',
        permissionMode: 'acceptEdits',
      },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    // Phase 1: Establish Anthropic session
    await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
    await waitForIdle(daemon, sessionId);

    const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
    expect(sdkIdBefore).toBeTruthy();

    // Phase 2: Switch to GLM
    const switchResult = (await daemon.messageHub.request('session.model.switch', {
      sessionId,
      model: 'glm-5',
      provider: 'glm',
    })) as { success: boolean; model: string };
    expect(switchResult.success).toBe(true);

    await waitForIdle(daemon, sessionId);

    // Phase 3: Send message on GLM
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
      console.log('✓ sdkSessionId PRESERVED — resume worked for Anthropic→GLM');
    } else {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(
        `✗ sdkSessionId CHANGED for Anthropic→GLM. Before: ${sdkIdBefore}, After: ${sdkIdAfter}`
      );
    }
  }, 300000);

  /**
   * Test 6: SDK model ID observation
   *
   * Observe what SDK model IDs are used for each provider to confirm
   * the model mismatch hypothesis.
   */
  test('observe SDK model IDs: GLM uses "default", Anthropic uses actual model', async () => {
    // GLM session
    const { sessionId: glmSessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-model-observe-glm-${Date.now()}`,
      title: 'Model Observe GLM',
      config: { model: 'sonnet', provider: 'glm', permissionMode: 'acceptEdits' },
    })) as { sessionId: string };
    daemon.trackSession(glmSessionId);

    const glmInitPromise = waitForSystemInit(daemon, glmSessionId);
    await sendMessage(daemon, glmSessionId, 'Say "ok"');
    const glmInit = await glmInitPromise;
    await waitForIdle(daemon, glmSessionId);

    // Anthropic session
    const { sessionId: anthSessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: `${TMP_DIR}/test-model-observe-anth-${Date.now()}`,
      title: 'Model Observe Anthropic',
      config: { model: 'sonnet', provider: 'anthropic', permissionMode: 'acceptEdits' },
    })) as { sessionId: string };
    daemon.trackSession(anthSessionId);

    const anthInitPromise = waitForSystemInit(daemon, anthSessionId);
    await sendMessage(daemon, anthSessionId, 'Say "ok"');
    const anthInit = await anthInitPromise;
    await waitForIdle(daemon, anthSessionId);

    // biome-ignore lint/suspicious/noConsole: test diagnostic
    console.log(`GLM system:init model = "${glmInit.model}"`);
    // biome-ignore lint/suspicious/noConsole: test diagnostic
    console.log(`Anthropic system:init model = "${anthInit.model}"`);

    // Both should have model info
    expect(glmInit.model).toBeDefined();
    expect(anthInit.model).toBeDefined();

    // GLM should route via ANTHROPIC_DEFAULT_*_MODEL env vars
    // Anthropic should use the actual model name
    // The key observation: are these different enough to cause resume issues?
  }, 300000);

  /**
   * Test 7: MiniMax M2.7 → Anthropic sonnet (comparison with GLM)
   *
   * Same flow as Test 3 but with MiniMax as the initial provider.
   * Compare thinking block signatures between MiniMax and GLM.
   */
  test('MiniMax M2.7 → Anthropic sonnet: send message after switch', async () => {
    const workspacePath = `${TMP_DIR}/test-minimax-to-anthropic-${Date.now()}`;
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      title: 'MiniMax→Anthropic Resume',
      config: {
        model: 'MiniMax-M2.7',
        provider: 'minimax',
        permissionMode: 'acceptEdits',
      },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);

    // Phase 1: Establish MiniMax session with a message
    await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
    await waitForIdle(daemon, sessionId);

    const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
    expect(sdkIdBefore).toBeTruthy();

    // Dump thinking blocks from MiniMax session
    dumpThinkingBlocks(workspacePath, sdkIdBefore, 'MiniMax→Anthropic BEFORE switch');

    // Check session file exists before switch
    const filePathBefore = getSDKSessionFilePath(workspacePath, sdkIdBefore);
    const fileExistsBefore = existsSync(filePathBefore);
    // biome-ignore lint/suspicious/noConsole: test diagnostic
    console.log(`[MiniMax→Anthropic] Before switch: session file exists=${fileExistsBefore}`);

    // Phase 2: Switch to Anthropic sonnet
    const switchResult = (await daemon.messageHub.request('session.model.switch', {
      sessionId,
      model: 'sonnet',
      provider: 'anthropic',
    })) as { success: boolean; model: string };
    expect(switchResult.success).toBe(true);

    await waitForIdle(daemon, sessionId);

    // Phase 3: Send message on Anthropic — compare behavior with GLM test
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
      console.log('✓ sdkSessionId PRESERVED — resume worked across MiniMax→Anthropic');
    } else {
      // biome-ignore lint/suspicious/noConsole: test diagnostic
      console.log(
        `✗ sdkSessionId CHANGED — resume failed. Before: ${sdkIdBefore}, After: ${sdkIdAfter}`
      );
    }
  }, 300000);
});
