/**
 * Bug 2 Investigation: Does model switching take effect without code changes?
 *
 * Runs with REAL API credentials (NOT dev proxy) so we can observe actual
 * system:init.model values from live SDK subprocesses.
 *
 * Flow:
 * 1. Create a session with claude-haiku-4-5-20251001
 * 2. Send two messages (including a tool-use turn) and capture system:init.model each time
 * 3. Switch model to MiniMax-M2.7-highspeed (different provider)
 * 4. Send one more message and capture system:init.model after the switch
 * 5. Report all findings
 *
 * Run:
 *   bun run packages/daemon/tests/online/rpc/bug2-model-switch-investigation.ts
 *
 * Requires: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (for haiku turns)
 *           MINIMAX_API_KEY (for post-switch turn)
 */

import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';
import { waitForSystemInit } from '../../helpers/sdk-message-helpers';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TMP_DIR = tmpdir();

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log('Bug 2 Investigation: Model switching system:init observation');
  console.log('='.repeat(70));

  // Create a real workspace directory so Claude Code SDK has a valid path
  const workspacePath = join(TMP_DIR, `bug2-investigation-${Date.now()}`);
  mkdirSync(workspacePath, { recursive: true });
  console.log(`\nWorkspace: ${workspacePath}`);

  const daemon = await createDaemonServer();
  console.log(`Daemon started at: ${daemon.baseUrl}\n`);

  try {
    // ── Create session with haiku ────────────────────────────────────────
    const INITIAL_MODEL = 'claude-haiku-4-5-20251001';
    const SWITCHED_MODEL = 'MiniMax-M2.7-highspeed';
    const SWITCHED_PROVIDER = 'minimax';

    console.log(`Creating session with model: ${INITIAL_MODEL}`);
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
      config: {
        model: INITIAL_MODEL,
        permissionMode: 'acceptEdits',
      },
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    console.log(`Session created: ${sessionId}\n`);

    // ── Turn 1: simple message ───────────────────────────────────────────
    console.log('--- Turn 1: Simple message (before switch) ---');
    const turn1SysInitPromise = waitForSystemInit(daemon, sessionId);
    console.log('Sending: "What is 1+1? Reply with just the number."');
    await sendMessage(daemon, sessionId, 'What is 1+1? Reply with just the number.');
    const turn1SysInit = await turn1SysInitPromise;
    console.log(`system:init.model (turn 1): ${turn1SysInit.model}`);
    console.log(`system:init keys: ${Object.keys(turn1SysInit).join(', ')}`);
    await waitForIdle(daemon, sessionId, 60000);
    console.log('Turn 1 complete.\n');

    // ── Turn 2: message with tool use ────────────────────────────────────
    console.log('--- Turn 2: Tool-use message (before switch) ---');
    const turn2SysInitPromise = waitForSystemInit(daemon, sessionId);
    console.log('Sending: "Run: echo hello-world and tell me what it printed."');
    await sendMessage(
      daemon,
      sessionId,
      'Run the bash command: echo hello-world — and tell me the exact output.'
    );
    const turn2SysInit = await turn2SysInitPromise;
    console.log(`system:init.model (turn 2): ${turn2SysInit.model}`);
    await waitForIdle(daemon, sessionId, 90000);
    console.log('Turn 2 complete.\n');

    // ── Model switch ─────────────────────────────────────────────────────
    console.log(`--- Switching model: ${INITIAL_MODEL} → ${SWITCHED_MODEL} ---`);
    let switchError: string | undefined;
    let switchResult: { success: boolean; model?: string } | undefined;
    try {
      switchResult = (await daemon.messageHub.request('session.model.switch', {
        sessionId,
        model: SWITCHED_MODEL,
        provider: SWITCHED_PROVIDER,
      })) as { success: boolean; model?: string };
      console.log(`Switch result: success=${switchResult.success}, model=${switchResult.model}`);
    } catch (err) {
      switchError = String(err);
      console.log(`Switch FAILED with error: ${switchError}`);
    }
    console.log();

    // ── Turn 3: post-switch message ──────────────────────────────────────
    if (switchError) {
      console.log('Skipping turn 3 because model switch failed.');
    } else {
      console.log('--- Turn 3: Post-switch message ---');
      // Subscribe AFTER RPC completes to avoid restart() teardown race
      const turn3SysInitPromise = waitForSystemInit(daemon, sessionId);
      console.log('Sending: "What is 2+2? Reply with just the number."');
      let turn3Error: string | undefined;
      try {
        await sendMessage(daemon, sessionId, 'What is 2+2? Reply with just the number.');
        const turn3SysInit = await turn3SysInitPromise;
        console.log(`system:init.model (turn 3): ${turn3SysInit.model}`);
        await waitForIdle(daemon, sessionId, 90000);
        console.log('Turn 3 complete.\n');

        // ── Summary ──────────────────────────────────────────────────────────
        console.log('='.repeat(70));
        console.log('RESULTS SUMMARY');
        console.log('='.repeat(70));
        console.log(`Turn 1 (before switch) system:init.model : ${turn1SysInit.model}`);
        console.log(`Turn 2 (before switch) system:init.model : ${turn2SysInit.model}`);
        console.log(`Turn 3 (after  switch) system:init.model : ${turn3SysInit.model}`);
        console.log();

        const modelChanged = turn3SysInit.model !== turn2SysInit.model;
        if (modelChanged) {
          console.log('CONCLUSION: PASS — system:init.model changed after switch.');
          console.log(`  Before: ${turn2SysInit.model}`);
          console.log(`  After:  ${turn3SysInit.model}`);
          console.log(
            '  Bug 2 does NOT exist (or is already fixed) — the SDK honors the new model.'
          );
          process.exit(0);
        } else {
          console.log('CONCLUSION: FAIL — system:init.model did NOT change after switch.');
          console.log(`  Before: ${turn2SysInit.model}`);
          console.log(`  After:  ${turn3SysInit.model} (SAME)`);
          console.log(
            '  Bug 2 CONFIRMED — the SDK is resuming with the old model from the session file.'
          );
          console.log('  Fix needed: clear sdkSessionId in restart() during model switch.');
          process.exit(1);
        }
      } catch (err) {
        turn3Error = String(err);
        console.log(`Turn 3 FAILED or timed out: ${turn3Error}`);
        console.log();
        console.log('='.repeat(70));
        console.log('RESULTS SUMMARY');
        console.log('='.repeat(70));
        console.log(`Turn 1 system:init.model : ${turn1SysInit.model}`);
        console.log(`Turn 2 system:init.model : ${turn2SysInit.model}`);
        console.log(`Turn 3 FAILED: ${turn3Error}`);
        console.log();
        console.log(
          'CONCLUSION: INCONCLUSIVE — agent did not respond after switch (possible Bug 2 symptom).'
        );
        process.exit(1);
      }
    }
  } finally {
    daemon.kill('SIGTERM');
    await daemon.waitForExit();
    rmSync(workspacePath, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
