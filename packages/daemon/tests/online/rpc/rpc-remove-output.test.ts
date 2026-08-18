import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import type { DaemonAppContext } from '../../../src/app';

const TMP_DIR = process.env.TMPDIR || '/tmp/claude';

describe('Message Remove Output', () => {
  let daemon: DaemonServerContext & { daemonContext: DaemonAppContext };
  let testSessionDir: string;
  let originalTestSdkSessionDir: string | undefined;

  beforeEach(async () => {
    const testSdkDir = join(
      TMP_DIR,
      `sdk-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    originalTestSdkSessionDir = process.env.TEST_SDK_SESSION_DIR;
    process.env.TEST_SDK_SESSION_DIR = testSdkDir;

    daemon = (await createDaemonServer()) as DaemonServerContext & {
      daemonContext: DaemonAppContext;
    };
  }, 30_000);

  afterEach(async () => {
    if (daemon) {
      await daemon.waitForExit();
    }

    if (process.env.TEST_SDK_SESSION_DIR && existsSync(process.env.TEST_SDK_SESSION_DIR)) {
      try {
        rmSync(process.env.TEST_SDK_SESSION_DIR, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    if (originalTestSdkSessionDir !== undefined) {
      process.env.TEST_SDK_SESSION_DIR = originalTestSdkSessionDir;
    } else {
      delete process.env.TEST_SDK_SESSION_DIR;
    }
  }, 30_000);
  async function createSession(): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath: process.cwd(),
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  function setSDKSessionId(sessionId: string, sdkSessionId: string | null): void {
    const agentSession = daemon.daemonContext.sessionManager.getSession(sessionId);
    if (agentSession) {
      agentSession.getSDKSessionId = () => sdkSessionId;
    }
  }

  function createMockSDKSessionFile(
    workspacePath: string,
    sdkSessionId: string,
    sessionId: string,
    messageUuid: string
  ): string {
    const projectKey = workspacePath.replace(/[/.]/g, '-');
    testSessionDir = join(process.env.TEST_SDK_SESSION_DIR!, 'projects', projectKey);
    mkdirSync(testSessionDir, { recursive: true });

    const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);
    const messages = [
      JSON.stringify({
        type: 'user',
        uuid: '00000000-0000-0000-0000-000000000001',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: '00000000-0000-0000-0000-000000000002',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_001',
              name: 'Task',
              input: { prompt: 'Test task' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: messageUuid,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_001',
              content: [
                {
                  type: 'text',
                  text: 'This is a very large output that we want to remove to save context window space. '.repeat(
                    100
                  ),
                },
              ],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: '00000000-0000-0000-0000-000000000004',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
        },
      }),
    ];

    writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');
    return sessionFilePath;
  }

  function readSDKSessionFile(filePath: string): unknown[] {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());
    return lines.map((line) => JSON.parse(line));
  }

  describe('Remove tool_result with SDK session ID', () => {
    test('should remove tool_result content from message', async () => {
      const sessionId = await createSession();
      const messageUuid = '00000000-0000-0000-0000-000000000003';
      const sdkSessionId = 'test-sdk-session-123';
      const sessionFile = createMockSDKSessionFile(
        process.cwd(),
        sdkSessionId,
        sessionId,
        messageUuid
      );

      expect(existsSync(sessionFile)).toBe(true);

      setSDKSessionId(sessionId, sdkSessionId);

      const result = (await daemon.messageHub.request('message.removeOutput', {
        sessionId,
        messageUuid,
      })) as { success: boolean };

      expect(result.success).toBe(true);

      const messagesAfter = readSDKSessionFile(sessionFile);
      expect(messagesAfter.length).toBe(4);

      const targetMessage = messagesAfter.find(
        (msg: unknown) => (msg as Record<string, unknown>).uuid === messageUuid
      ) as Record<string, unknown>;
      expect(targetMessage).toBeDefined();

      const content = (targetMessage.message as Record<string, unknown>).content as unknown[];
      const toolResult = content[0] as Record<string, unknown>;
      const replacedContent = toolResult.content as unknown[];
      expect(replacedContent.length).toBe(1);
      expect((replacedContent[0] as Record<string, unknown>).text).toBe(
        '⚠️ Output removed by user. Run again with filter to narrow down the message.'
      );
    });

    test('should preserve other messages when removing tool_result', async () => {
      const sessionId = await createSession();
      const messageUuid = '00000000-0000-0000-0000-000000000003';
      const sdkSessionId = 'test-sdk-session-456';
      const sessionFile = createMockSDKSessionFile(
        process.cwd(),
        sdkSessionId,
        sessionId,
        messageUuid
      );

      setSDKSessionId(sessionId, sdkSessionId);

      const messagesBefore = readSDKSessionFile(sessionFile);

      await daemon.messageHub.request('message.removeOutput', {
        sessionId,
        messageUuid,
      });

      const messagesAfter = readSDKSessionFile(sessionFile);
      expect(JSON.stringify(messagesAfter[0])).toBe(JSON.stringify(messagesBefore[0]));
      expect(JSON.stringify(messagesAfter[3])).toBe(JSON.stringify(messagesBefore[3]));
    });
  });

  describe('Fallback search by HyperNeo session ID', () => {
    test('should find session file when SDK session ID unavailable', async () => {
      const sessionId = await createSession();
      const messageUuid = '00000000-0000-0000-0000-000000000003';
      const sdkSessionId = 'test-sdk-session-789';
      createMockSDKSessionFile(process.cwd(), sdkSessionId, sessionId, messageUuid);

      setSDKSessionId(sessionId, null);

      const result = (await daemon.messageHub.request('message.removeOutput', {
        sessionId,
        messageUuid,
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });

  describe('Error handling', () => {
    test('should throw for invalid session ID', async () => {
      await expect(
        daemon.messageHub.request('message.removeOutput', {
          sessionId: 'invalid-session-id',
          messageUuid: '00000000-0000-0000-0000-000000000003',
        })
      ).rejects.toThrow('Session not found');
    });

    test('should throw when session file not found', async () => {
      const sessionId = await createSession();
      setSDKSessionId(sessionId, 'nonexistent-sdk-session');

      await expect(
        daemon.messageHub.request('message.removeOutput', {
          sessionId,
          messageUuid: '00000000-0000-0000-0000-000000000003',
        })
      ).rejects.toThrow('Failed to remove output from SDK session file');
    });

    test('should throw when message UUID not found in file', async () => {
      const sessionId = await createSession();
      const sdkSessionId = 'test-sdk-session-error-1';
      createMockSDKSessionFile(
        process.cwd(),
        sdkSessionId,
        sessionId,
        '00000000-0000-0000-0000-000000000003'
      );
      setSDKSessionId(sessionId, sdkSessionId);

      await expect(
        daemon.messageHub.request('message.removeOutput', {
          sessionId,
          messageUuid: 'nonexistent-message-uuid',
        })
      ).rejects.toThrow('Failed to remove output from SDK session file');
    });

    test('should throw when message has no tool_result', async () => {
      const sessionId = await createSession();
      const sdkSessionId = 'test-sdk-session-error-2';
      const projectKey = process.cwd().replace(/[/.]/g, '-');
      testSessionDir = join(process.env.TEST_SDK_SESSION_DIR!, 'projects', projectKey);
      mkdirSync(testSessionDir, { recursive: true });

      const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);
      const messageUuid = '00000000-0000-0000-0000-000000000005';
      writeFileSync(
        sessionFilePath,
        JSON.stringify({
          type: 'user',
          uuid: messageUuid,
          session_id: sessionId,
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Just text, no tool_result' }],
          },
        }) + '\n',
        'utf-8'
      );

      setSDKSessionId(sessionId, sdkSessionId);

      await expect(
        daemon.messageHub.request('message.removeOutput', {
          sessionId,
          messageUuid,
        })
      ).rejects.toThrow('Failed to remove output from SDK session file');
    });
  });

  describe('File content integrity', () => {
    test('should maintain valid JSONL structure after removal', async () => {
      const sessionId = await createSession();
      const messageUuid = '00000000-0000-0000-0000-000000000003';
      const sdkSessionId = 'test-sdk-session-integrity';
      const sessionFile = createMockSDKSessionFile(
        process.cwd(),
        sdkSessionId,
        sessionId,
        messageUuid
      );

      setSDKSessionId(sessionId, sdkSessionId);

      await daemon.messageHub.request('message.removeOutput', {
        sessionId,
        messageUuid,
      });

      const content = readFileSync(sessionFile, 'utf-8');
      expect(content.endsWith('\n')).toBe(true);

      const lines = content.split('\n').filter((line) => line.trim());
      lines.forEach((line) => {
        expect(() => JSON.parse(line)).not.toThrow();
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty('type');
        expect(parsed).toHaveProperty('uuid');
        expect(parsed).toHaveProperty('message');
      });
    });
  });

  describe('Multiple tool results', () => {
    test('should only modify tool_result in specified message', async () => {
      const sessionId = await createSession();
      const sdkSessionId = 'test-sdk-session-multiple';
      const projectKey = process.cwd().replace(/[/.]/g, '-');
      testSessionDir = join(process.env.TEST_SDK_SESSION_DIR!, 'projects', projectKey);
      mkdirSync(testSessionDir, { recursive: true });

      const targetMessageUuid = '00000000-0000-0000-0000-000000000003';
      const otherMessageUuid = '00000000-0000-0000-0000-000000000005';

      const sessionFilePath = join(testSessionDir, `${sdkSessionId}.jsonl`);
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: targetMessageUuid,
          session_id: sessionId,
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_001',
                content: [{ type: 'text', text: 'Target result to remove' }],
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: otherMessageUuid,
          session_id: sessionId,
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_002',
                content: [{ type: 'text', text: 'Other result to keep' }],
              },
            ],
          },
        }),
      ];
      writeFileSync(sessionFilePath, messages.join('\n') + '\n', 'utf-8');

      setSDKSessionId(sessionId, sdkSessionId);

      await daemon.messageHub.request('message.removeOutput', {
        sessionId,
        messageUuid: targetMessageUuid,
      });

      const messagesAfter = readSDKSessionFile(sessionFilePath);
      const targetMessage = messagesAfter.find(
        (msg: unknown) => (msg as Record<string, unknown>).uuid === targetMessageUuid
      ) as Record<string, unknown>;
      const otherMessage = messagesAfter.find(
        (msg: unknown) => (msg as Record<string, unknown>).uuid === otherMessageUuid
      ) as Record<string, unknown>;

      const targetContent = (targetMessage.message as Record<string, unknown>).content as unknown[];
      const targetToolResult = targetContent[0] as Record<string, unknown>;
      expect(
        ((targetToolResult.content as unknown[])[0] as Record<string, unknown>).text
      ).toContain('⚠️ Output removed by user');

      const otherContent = (otherMessage.message as Record<string, unknown>).content as unknown[];
      const otherToolResult = otherContent[0] as Record<string, unknown>;
      expect(((otherToolResult.content as unknown[])[0] as Record<string, unknown>).text).toBe(
        'Other result to keep'
      );
    });
  });
});
