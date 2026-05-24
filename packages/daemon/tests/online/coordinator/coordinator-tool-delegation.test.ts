/**
 * Coordinator Tool Delegation - Behavioral Tests
 *
 * Tests coordinator mode behavior with tool usage:
 * 1. Coordinator can read files directly (read-only, no delegation needed)
 * 2. Coordinator delegates file writing to specialist sub-agents via Task
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
// Bun automatically loads .env from project root when running tests
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

/** Mutation tools the coordinator should NOT use — must delegate to specialists */
const MUTATION_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

/**
 * Collect all SDK messages for a session after processing completes.
 * Uses the message.sdkMessages RPC to fetch the full message list.
 */
async function getAllSDKMessages(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<Array<Record<string, unknown>>> {
  const result = (await daemon.messageHub.request('message.sdkMessages', {
    sessionId,
  })) as { sdkMessages: Array<Record<string, unknown>> };
  return result.sdkMessages || [];
}

/**
 * Extract tool_use blocks from the coordinator's (main thread) assistant messages.
 *
 * Coordinator messages have parent_tool_use_id === null (they're on the main thread).
 * Sub-agent messages have parent_tool_use_id !== null (they're spawned via Task).
 */
function getCoordinatorToolUses(
  messages: Array<Record<string, unknown>>
): Array<{ name: string; id: string }> {
  const toolUses: Array<{ name: string; id: string }> = [];

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    if (msg.parent_tool_use_id !== null) continue; // skip sub-agent messages

    const betaMessage = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
    if (!betaMessage?.content) continue;

    for (const block of betaMessage.content) {
      if (block.type === 'tool_use') {
        toolUses.push({
          name: block.name as string,
          id: block.id as string,
        });
      }
    }
  }

  return toolUses;
}

/**
 * Extract the final text response from assistant messages on the main thread.
 */
function getCoordinatorTextResponse(messages: Array<Record<string, unknown>>): string {
  const texts: string[] = [];

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    if (msg.parent_tool_use_id !== null) continue;

    const betaMessage = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
    if (!betaMessage?.content) continue;

    for (const block of betaMessage.content) {
      if (block.type === 'text') {
        texts.push(block.text as string);
      }
    }
  }

  return texts.join('\n');
}

// TODO: Re-enable when CI concurrency issues are resolved
// These tests keep getting cancelled due to concurrent runs and use GLM API
describe.skip('Coordinator Tool Delegation - Behavioral', () => {
  let daemon: DaemonServerContext;
  let testDir: string;

  beforeEach(async () => {
    daemon = await createDaemonServer({
      env: {
        GLM_API_KEY: process.env.GLM_API_KEY!,
        DEFAULT_PROVIDER: 'glm',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
      },
    });
    testDir = join(TMP_DIR, `coordinator-delegation-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  }, 30000);

  afterEach(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await daemon.waitForExit();
    }
  }, 20000);

  test('coordinator reads files directly — canary value appears in response', async () => {
    // 1. Create a file with a unique canary value
    const canary = `CANARY_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const testFile = join(testDir, 'canary.txt');
    writeFileSync(testFile, canary);

    // 2. Create a coordinator mode session
    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath: testDir,
      title: 'Coordinator Read Test',
      config: {
        coordinatorMode: true,
        permissionMode: 'bypassPermissions',
        model: 'glm-5',
      },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    // 3. Ask the coordinator to read the file
    await sendMessage(
      daemon,
      sessionId,
      `Read the file at ${testFile} and tell me exactly what it contains. Just respond with the file content, nothing else.`
    );

    // 4. Wait for full processing
    await waitForIdle(daemon, sessionId, 180000);

    // 5. Collect all SDK messages
    const allMessages = await getAllSDKMessages(daemon, sessionId);

    // 6. Verify the canary value appears in the coordinator's response
    // This is the core assertion - the coordinator must get the file content somehow
    const coordinatorText = getCoordinatorTextResponse(allMessages);
    expect(coordinatorText).toContain(canary);
  }, 180000);

  test('coordinator delegates file writing to specialist — file is actually created', async () => {
    const outputFile = join(testDir, 'output.txt');
    const canary = `WRITTEN_BY_SPECIALIST_${Date.now()}`;

    // 1. Create a coordinator mode session
    const createResult = (await daemon.messageHub.request('session.create', {
      workspacePath: testDir,
      title: 'Coordinator Write Delegation Test',
      config: {
        coordinatorMode: true,
        permissionMode: 'bypassPermissions',
        model: 'glm-5',
      },
    })) as { sessionId: string };

    const { sessionId } = createResult;
    daemon.trackSession(sessionId);

    // 2. Ask the coordinator to write a file
    await sendMessage(
      daemon,
      sessionId,
      `Create a file at ${outputFile} with exactly this content: ${canary}`
    );

    // 3. Wait for processing (coordinator + specialist delegation takes longer)
    await waitForIdle(daemon, sessionId, 180000);

    // 4. Collect all SDK messages
    const allMessages = await getAllSDKMessages(daemon, sessionId);

    // 5. Verify the file was actually written
    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, 'utf-8');
    expect(content).toContain(canary);

    // Verify coordinator tool usage
    const coordinatorToolUses = getCoordinatorToolUses(allMessages);

    // Verify delegation happened — coordinator should use Task/Agent for mutations
    // SDK 0.2.76+ renamed the tool from 'Task' to 'Agent'; accept both names
    const taskUses = coordinatorToolUses.filter((t) => t.name === 'Task' || t.name === 'Agent');
    expect(taskUses.length).toBeGreaterThan(0);

    // Verify the coordinator did NOT use mutation tools directly
    const mutationUses = coordinatorToolUses.filter((t) => MUTATION_TOOLS.has(t.name));
    expect(mutationUses).toEqual([]);

    // Cleanup
    try {
      unlinkSync(outputFile);
    } catch {
      // ignore
    }
  }, 180000);
});
