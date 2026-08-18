import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

const MUTATION_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);

async function getAllSDKMessages(
  daemon: DaemonServerContext,
  sessionId: string
): Promise<Array<Record<string, unknown>>> {
  const result = (await daemon.messageHub.request('message.sdkMessages', {
    sessionId,
  })) as { sdkMessages: Array<Record<string, unknown>> };
  return result.sdkMessages || [];
}

function getCoordinatorToolUses(
  messages: Array<Record<string, unknown>>
): Array<{ name: string; id: string }> {
  const toolUses: Array<{ name: string; id: string }> = [];

  for (const msg of messages) {
    if (msg.type !== 'assistant') continue;
    if (msg.parent_tool_use_id !== null) continue;

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
    const canary = `CANARY_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const testFile = join(testDir, 'canary.txt');
    writeFileSync(testFile, canary);

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

    await sendMessage(
      daemon,
      sessionId,
      `Read the file at ${testFile} and tell me exactly what it contains. Just respond with the file content, nothing else.`
    );

    await waitForIdle(daemon, sessionId, 180000);

    const allMessages = await getAllSDKMessages(daemon, sessionId);

    const coordinatorText = getCoordinatorTextResponse(allMessages);
    expect(coordinatorText).toContain(canary);
  }, 180000);

  test('coordinator delegates file writing to specialist — file is actually created', async () => {
    const outputFile = join(testDir, 'output.txt');
    const canary = `WRITTEN_BY_SPECIALIST_${Date.now()}`;

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

    await sendMessage(
      daemon,
      sessionId,
      `Create a file at ${outputFile} with exactly this content: ${canary}`
    );

    await waitForIdle(daemon, sessionId, 180000);

    const allMessages = await getAllSDKMessages(daemon, sessionId);

    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, 'utf-8');
    expect(content).toContain(canary);

    const coordinatorToolUses = getCoordinatorToolUses(allMessages);

    const taskUses = coordinatorToolUses.filter((t) => t.name === 'Task' || t.name === 'Agent');
    expect(taskUses.length).toBeGreaterThan(0);

    const mutationUses = coordinatorToolUses.filter((t) => MUTATION_TOOLS.has(t.name));
    expect(mutationUses).toEqual([]);

    try {
      unlinkSync(outputFile);
    } catch {
      // ignore
    }
  }, 180000);
});
