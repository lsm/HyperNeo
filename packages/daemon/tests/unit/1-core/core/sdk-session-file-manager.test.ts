import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateSDKSessionFile,
  getSDKSessionFilePath,
  repairSDKSessionFile,
  validateAndRepairSDKSession,
  deleteSDKSessionFiles,
  archiveSDKSessionFiles,
  scanSDKSessionFiles,
  identifyOrphanedSDKFiles,
  removeToolResultFromSessionFile,
  truncateSessionFileAtMessage,
  messageUuidExistsInSessionFile,
  findSDKSessionFileGlobally,
  migrateSDKSessionFile,
  sanitizeAssistantUsageInSDKSessionFile,
} from '../../../../src/lib/sdk-session-file-manager';
import type { Database } from '../../../../src/storage/database';

const TMP_DIR = process.env.TMPDIR || '/tmp/claude';

describe('SDK Session File Manager', () => {
  const testWorkspacePath = '/tmp/test-workspace-sdk-validation';
  const testSdkSessionId = 'test-sdk-session-validation';
  let testSessionDir: string;
  let testSessionFile: string;
  let originalTestSdkSessionDir: string | undefined;

  beforeEach(() => {
    const testSdkDir = join(
      TMP_DIR,
      `sdk-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    originalTestSdkSessionDir = process.env.TEST_SDK_SESSION_DIR;
    process.env.TEST_SDK_SESSION_DIR = testSdkDir;

    const projectKey = testWorkspacePath.replace(/[/.]/g, '-');
    testSessionDir = join(testSdkDir, 'projects', projectKey);
    mkdirSync(testSessionDir, { recursive: true });
    testSessionFile = join(testSessionDir, `${testSdkSessionId}.jsonl`);
  });

  afterEach(() => {
    if (process.env.TEST_SDK_SESSION_DIR && existsSync(process.env.TEST_SDK_SESSION_DIR)) {
      try {
        rmSync(process.env.TEST_SDK_SESSION_DIR, { recursive: true, force: true });
      } catch {}
    }

    if (originalTestSdkSessionDir !== undefined) {
      process.env.TEST_SDK_SESSION_DIR = originalTestSdkSessionDir;
    } else {
      delete process.env.TEST_SDK_SESSION_DIR;
    }
  });

  describe('getSDKSessionFilePath', () => {
    test('should construct correct path with workspace encoding', () => {
      const path = getSDKSessionFilePath('/Users/test/project', 'session-123');
      expect(path).toContain('projects/-Users-test-project/session-123.jsonl');
    });

    test('should handle dots and slashes in workspace path', () => {
      const path = getSDKSessionFilePath('/Users/test/.hidden/project', 'session-123');
      expect(path).toContain('projects/-Users-test--hidden-project');
    });
  });

  describe('sanitizeAssistantUsageInSDKSessionFile', () => {
    test('adds default usage to legacy assistant messages', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
        }),
      ];
      writeFileSync(testSessionFile, `${messages.join('\n')}\n`, 'utf-8');

      const result = sanitizeAssistantUsageInSDKSessionFile(testWorkspacePath, testSdkSessionId);

      expect(result.success).toBe(true);
      expect(result.sanitizedCount).toBe(1);
      const lines = readFileSync(testSessionFile, 'utf-8').trim().split('\n');
      const assistant = JSON.parse(lines[1]);
      expect(assistant.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    });

    test('preserves existing usage fields while filling missing token counts', () => {
      writeFileSync(
        testSessionFile,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            usage: { input_tokens: 42, cache_creation_input_tokens: 7 },
          },
        })}\n`,
        'utf-8'
      );

      const result = sanitizeAssistantUsageInSDKSessionFile(testWorkspacePath, testSdkSessionId);

      expect(result.success).toBe(true);
      expect(result.sanitizedCount).toBe(1);
      const assistant = JSON.parse(readFileSync(testSessionFile, 'utf-8').trim());
      expect(assistant.message.usage).toEqual({
        input_tokens: 42,
        cache_creation_input_tokens: 7,
        output_tokens: 0,
      });
    });

    test('does not rewrite file when all assistant messages already have valid usage', () => {
      const original = `${JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      })}\n`;
      writeFileSync(testSessionFile, original, 'utf-8');
      const before = readFileSync(testSessionFile, 'utf-8');

      const result = sanitizeAssistantUsageInSDKSessionFile(testWorkspacePath, testSdkSessionId);

      expect(result.success).toBe(true);
      expect(result.sanitizedCount).toBe(0);
      expect(readFileSync(testSessionFile, 'utf-8')).toBe(before);
    });

    test('replaces non-numeric and invalid token values with 0', () => {
      writeFileSync(
        testSessionFile,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hi' }],
            usage: { input_tokens: 'not-a-number', output_tokens: Number.NaN },
          },
        })}\n`,
        'utf-8'
      );

      const result = sanitizeAssistantUsageInSDKSessionFile(testWorkspacePath, testSdkSessionId);

      expect(result.success).toBe(true);
      expect(result.sanitizedCount).toBe(1);
      const assistant = JSON.parse(readFileSync(testSessionFile, 'utf-8').trim());
      expect(assistant.message.usage.input_tokens).toBe(0);
      expect(assistant.message.usage.output_tokens).toBe(0);
    });

    test('does not rewrite non-existent session files', () => {
      const result = sanitizeAssistantUsageInSDKSessionFile(
        testWorkspacePath,
        'nonexistent-session'
      );

      expect(result.success).toBe(true);
      expect(result.filePath).toBeNull();
      expect(result.sanitizedCount).toBe(0);
    });
  });

  describe('validateSDKSessionFile', () => {
    test('should return valid for non-existent file', () => {
      const result = validateSDKSessionFile(testWorkspacePath, 'nonexistent-session');
      expect(result.valid).toBe(true);
      expect(result.orphanedToolResults).toHaveLength(0);
    });

    test('should return valid for file with matching tool_use/tool_result pairs', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool_001', name: 'Bash', input: {} }],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'user-2',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_001',
                content: 'result',
              },
            ],
          },
        }),
      ];

      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
      expect(result.valid).toBe(true);
      expect(result.orphanedToolResults).toHaveLength(0);
    });

    test('should detect orphaned tool_result (missing tool_use)', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'orphan_tool_001',
                content: 'result',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Response' }],
          },
        }),
      ];

      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
      expect(result.valid).toBe(false);
      expect(result.orphanedToolResults).toHaveLength(1);
      expect(result.orphanedToolResults[0].toolUseId).toBe('orphan_tool_001');
      expect(result.orphanedToolResults[0].messageUuid).toBe('user-1');
    });

    test('should detect multiple orphaned tool_results', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'orphan_001',
                content: 'result 1',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'user-2',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'orphan_002',
                content: 'result 2',
              },
            ],
          },
        }),
      ];

      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
      expect(result.valid).toBe(false);
      expect(result.orphanedToolResults).toHaveLength(2);
    });

    test('should handle mixed valid and orphaned tool_results', () => {
      const messages = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'valid_tool', name: 'Bash', input: {} }],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'valid_tool',
                content: 'valid',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'user-2',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'orphan_tool',
                content: 'orphan',
              },
            ],
          },
        }),
      ];

      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
      expect(result.valid).toBe(false);
      expect(result.orphanedToolResults).toHaveLength(1);
      expect(result.orphanedToolResults[0].toolUseId).toBe('orphan_tool');
    });

    test('should handle queue-operation messages (skip them)', () => {
      const messages = [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool_001', name: 'Bash', input: {} }],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'user-1',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_001',
                content: 'result',
              },
            ],
          },
        }),
      ];

      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
      expect(result.valid).toBe(true);
    });

    test('should handle malformed JSON lines gracefully', () => {
      const content = [
        '{"type":"assistant","uuid":"a1","message":{"content":[{"type":"tool_use","id":"t1"}]}}',
        'not valid json',
        '{"type":"user","uuid":"u1","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}',
      ].join('\n');

      writeFileSync(testSessionFile, content + '\n', 'utf-8');

      const result = validateSDKSessionFile(testWorkspacePath, testSdkSessionId);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Failed to parse line 1');
    });
  });

  describe('repairSDKSessionFile', () => {
    const createMockDb = (messages: Array<{ type: string; uuid: string; message: unknown }>) => {
      return {
        getSDKMessages: () => ({
          messages: messages.map((m) => ({
            ...m,
            timestamp: Date.now(),
          })),
          hasMore: false,
        }),
      } as unknown as Database;
    };

    test('should return success for already valid file', () => {
      const messages = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const mockDb = createMockDb([]);
      const result = repairSDKSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'hyperneo-session-1',
        mockDb
      );

      expect(result.success).toBe(true);
      expect(result.repairedCount).toBe(0);
      expect(result.backupPath).toBeNull();
    });

    test('should create backup before repair', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          parentUuid: 'missing-parent',
          cwd: testWorkspacePath,
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'orphan_t1' }],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const mockDb = createMockDb([
        {
          type: 'assistant',
          uuid: 'missing-parent',
          message: {
            content: [{ type: 'tool_use', id: 'orphan_t1', name: 'TaskOutput' }],
          },
        },
      ]);

      const result = repairSDKSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'hyperneo-session-1',
        mockDb
      );

      expect(result.backupPath).not.toBeNull();
      expect(existsSync(result.backupPath!)).toBe(true);
    });

    test('should insert missing tool_use message', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          parentUuid: 'missing-parent',
          cwd: testWorkspacePath,
          version: '2.1.1',
          gitBranch: 'test-branch',
          slug: 'test-slug',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'orphan_t1' }],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const mockDb = createMockDb([
        {
          type: 'assistant',
          uuid: 'recovered-assistant-uuid',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'orphan_t1',
                name: 'TaskOutput',
                input: {},
              },
            ],
          },
        },
      ]);

      const result = repairSDKSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'hyperneo-session-1',
        mockDb
      );

      expect(result.success).toBe(true);
      expect(result.repairedCount).toBe(1);

      const repairedContent = readFileSync(testSessionFile, 'utf-8');
      const lines = repairedContent.split('\n').filter((l) => l.trim());

      expect(lines.length).toBe(2);

      const firstMsg = JSON.parse(lines[0]);
      const secondMsg = JSON.parse(lines[1]);

      expect(firstMsg.type).toBe('assistant');
      expect(firstMsg.uuid).toBe('recovered-assistant-uuid');
      expect(firstMsg.message.content[0].type).toBe('tool_use');
      expect(firstMsg.message.content[0].id).toBe('orphan_t1');

      expect(secondMsg.type).toBe('user');
      expect(secondMsg.parentUuid).toBe('recovered-assistant-uuid');
    });

    test('should report error when tool_use not found in DB', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          parentUuid: 'missing-parent',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'unfindable_tool' }],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const mockDb = createMockDb([]);

      const result = repairSDKSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'hyperneo-session-1',
        mockDb
      );

      expect(result.success).toBe(false);
      expect(result.repairedCount).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Could not find tool_use message for unfindable_tool');
    });
  });

  describe('validateAndRepairSDKSession', () => {
    test('should return true for valid session', () => {
      const messages = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const mockDb = {
        getSDKMessages: () => ({ messages: [], hasMore: false }),
      } as unknown as Database;

      const result = validateAndRepairSDKSession(
        testWorkspacePath,
        testSdkSessionId,
        'hyperneo-session-1',
        mockDb
      );

      expect(result).toBe(true);
    });

    test('should return true after successful repair', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          parentUuid: 'missing-parent',
          cwd: testWorkspacePath,
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'orphan_t1' }],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const mockDb = {
        getSDKMessages: () => ({
          messages: [
            {
              type: 'assistant',
              uuid: 'recovered-uuid',
              message: {
                content: [{ type: 'tool_use', id: 'orphan_t1', name: 'TaskOutput' }],
              },
              timestamp: Date.now(),
            },
          ],
          hasMore: false,
        }),
      } as unknown as Database;

      const result = validateAndRepairSDKSession(
        testWorkspacePath,
        testSdkSessionId,
        'hyperneo-session-1',
        mockDb
      );

      expect(result).toBe(true);
    });

    test('should return false when repair fails', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'unfindable' }],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const mockDb = {
        getSDKMessages: () => ({ messages: [], hasMore: false }),
      } as unknown as Database;

      const result = validateAndRepairSDKSession(
        testWorkspacePath,
        testSdkSessionId,
        'hyperneo-session-1',
        mockDb
      );

      expect(result).toBe(false);
    });
  });

  describe('deleteSDKSessionFiles', () => {
    test('should return success with empty deletedFiles when no files exist', () => {
      const result = deleteSDKSessionFiles(
        '/nonexistent/workspace',
        'nonexistent-sdk-session',
        'hyperneo-session-1'
      );

      expect(result.success).toBe(true);
      expect(result.deletedFiles).toHaveLength(0);
      expect(result.deletedSize).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    test('should delete SDK session file by sdkSessionId', () => {
      const content = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      });
      writeFileSync(testSessionFile, content + '\n', 'utf-8');

      expect(existsSync(testSessionFile)).toBe(true);

      const result = deleteSDKSessionFiles(
        testWorkspacePath,
        testSdkSessionId,
        'hyperneo-session-1'
      );

      expect(result.success).toBe(true);
      expect(result.deletedFiles).toHaveLength(1);
      expect(result.deletedFiles[0]).toContain(testSdkSessionId);
      expect(result.deletedSize).toBeGreaterThan(0);
      expect(existsSync(testSessionFile)).toBe(false);
    });

    test('should find and delete SDK files by kaiSessionId when sdkSessionId is null', () => {
      const kaiSessionId = 'test-hyperneo-id-12345678';

      const content = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: kaiSessionId,
        message: { content: [{ type: 'text', text: 'Hello' }] },
      });
      writeFileSync(testSessionFile, content + '\n', 'utf-8');

      const result = deleteSDKSessionFiles(testWorkspacePath, null, kaiSessionId);

      expect(result.success).toBe(true);
      expect(result.deletedFiles.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('archiveSDKSessionFiles', () => {
    const kaiSessionId = 'test-archive-session-id';
    let archiveDir: string;

    beforeEach(() => {
      archiveDir = join(process.env.TEST_SDK_SESSION_DIR!, 'claude-session-archives', kaiSessionId);
    });

    afterEach(() => {
      if (existsSync(archiveDir)) {
        try {
          rmSync(archiveDir, { recursive: true, force: true });
        } catch {}
      }
    });

    test('should return success with empty archivedFiles when no files exist', () => {
      const result = archiveSDKSessionFiles(
        '/nonexistent/workspace',
        'nonexistent-sdk-session',
        kaiSessionId
      );

      expect(result.success).toBe(true);
      expect(result.archivedFiles).toHaveLength(0);
      expect(result.archivePath).toBeNull();
      expect(result.totalSize).toBe(0);
    });

    test('should archive SDK session file and create metadata', () => {
      const content = JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      });
      writeFileSync(testSessionFile, content + '\n', 'utf-8');

      expect(existsSync(testSessionFile)).toBe(true);

      const result = archiveSDKSessionFiles(testWorkspacePath, testSdkSessionId, kaiSessionId);

      expect(result.success).toBe(true);
      expect(result.archivePath).toBe(archiveDir);
      expect(result.archivedFiles).toHaveLength(1);
      expect(result.totalSize).toBeGreaterThan(0);

      expect(existsSync(testSessionFile)).toBe(false);

      const archivedFile = join(archiveDir, `${testSdkSessionId}.jsonl`);
      expect(existsSync(archivedFile)).toBe(true);

      const metadataFile = join(archiveDir, 'archive-metadata.json');
      expect(existsSync(metadataFile)).toBe(true);

      const metadata = JSON.parse(readFileSync(metadataFile, 'utf-8'));
      expect(metadata.kaiSessionId).toBe(kaiSessionId);
      expect(metadata.originalWorkspacePath).toBe(testWorkspacePath);
      expect(metadata.fileCount).toBe(1);
    });
  });

  describe('scanSDKSessionFiles', () => {
    test('should return empty array for nonexistent workspace', () => {
      const files = scanSDKSessionFiles('/nonexistent/workspace');
      expect(files).toHaveLength(0);
    });

    test('should find SDK session files in workspace', () => {
      const file1 = join(testSessionDir, 'sdk-session-1.jsonl');
      const file2 = join(testSessionDir, 'sdk-session-2.jsonl');

      writeFileSync(
        file1,
        JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'hyperneo-id-1' }) + '\n',
        'utf-8'
      );
      writeFileSync(
        file2,
        JSON.stringify({ type: 'user', uuid: 'u2', sessionId: 'hyperneo-id-2' }) + '\n',
        'utf-8'
      );

      const files = scanSDKSessionFiles(testWorkspacePath);

      expect(files.length).toBeGreaterThanOrEqual(2);

      const sdkSessionIds = files.map((f) => f.sdkSessionId);
      expect(sdkSessionIds).toContain('sdk-session-1');
      expect(sdkSessionIds).toContain('sdk-session-2');

      for (const file of files) {
        expect(file.size).toBeGreaterThan(0);
        expect(file.modifiedAt).toBeInstanceOf(Date);
      }
    });

    test('should extract HyperNeo session IDs from file content', () => {
      const kaiId = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

      const content = [
        JSON.stringify({ type: 'user', uuid: 'u1', kaiId }),
        JSON.stringify({ type: 'assistant', uuid: 'a1', kaiId }),
        JSON.stringify({ type: 'user', uuid: 'u2', kaiId }),
        JSON.stringify({ type: 'assistant', uuid: 'a2', kaiId }),
      ].join('\n');

      writeFileSync(testSessionFile, content + '\n', 'utf-8');

      const files = scanSDKSessionFiles(testWorkspacePath);
      const targetFile = files.find((f) => f.sdkSessionId === testSdkSessionId);

      expect(targetFile).toBeDefined();
      expect(targetFile!.kaiSessionIds).toContain(kaiId);
    });
  });

  describe('identifyOrphanedSDKFiles', () => {
    test('should return empty array when no files provided', () => {
      const orphaned = identifyOrphanedSDKFiles([], new Set(), new Set());
      expect(orphaned).toHaveLength(0);
    });

    test('should identify files with no matching session as orphaned', () => {
      const files = [
        {
          path: '/test/path/sdk-1.jsonl',
          sdkSessionId: 'sdk-1',
          kaiSessionIds: ['unknown-session-id'],
          size: 100,
          modifiedAt: new Date(),
        },
      ];

      const activeIds = new Set(['active-session-1', 'active-session-2']);
      const archivedIds = new Set(['archived-session-1']);

      const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].sdkSessionId).toBe('sdk-1');
      expect(orphaned[0].reason).toBe('no-matching-session');
    });

    test('should not mark files with active session as orphaned', () => {
      const files = [
        {
          path: '/test/path/sdk-1.jsonl',
          sdkSessionId: 'sdk-1',
          kaiSessionIds: ['active-session-1'],
          size: 100,
          modifiedAt: new Date(),
        },
      ];

      const activeIds = new Set(['active-session-1', 'active-session-2']);
      const archivedIds = new Set<string>();

      const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

      expect(orphaned).toHaveLength(0);
    });

    test('should not mark files with archived session as orphaned', () => {
      const files = [
        {
          path: '/test/path/sdk-1.jsonl',
          sdkSessionId: 'sdk-1',
          kaiSessionIds: ['archived-session-1'],
          size: 100,
          modifiedAt: new Date(),
        },
      ];

      const activeIds = new Set<string>();
      const archivedIds = new Set(['archived-session-1']);

      const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

      expect(orphaned).toHaveLength(0);
    });

    test('should mark files with no kaiSessionIds as unknown-session', () => {
      const files = [
        {
          path: '/test/path/sdk-1.jsonl',
          sdkSessionId: 'sdk-1',
          kaiSessionIds: [],
          size: 100,
          modifiedAt: new Date(),
        },
      ];

      const activeIds = new Set(['active-session-1']);
      const archivedIds = new Set<string>();

      const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].reason).toBe('unknown-session');
    });

    test('should handle mixed files correctly', () => {
      const files = [
        {
          path: '/test/path/active.jsonl',
          sdkSessionId: 'active',
          kaiSessionIds: ['active-session-1'],
          size: 100,
          modifiedAt: new Date(),
        },
        {
          path: '/test/path/archived.jsonl',
          sdkSessionId: 'archived',
          kaiSessionIds: ['archived-session-1'],
          size: 100,
          modifiedAt: new Date(),
        },
        {
          path: '/test/path/orphan.jsonl',
          sdkSessionId: 'orphan',
          kaiSessionIds: ['deleted-session'],
          size: 100,
          modifiedAt: new Date(),
        },
        {
          path: '/test/path/unknown.jsonl',
          sdkSessionId: 'unknown',
          kaiSessionIds: [],
          size: 100,
          modifiedAt: new Date(),
        },
      ];

      const activeIds = new Set(['active-session-1']);
      const archivedIds = new Set(['archived-session-1']);

      const orphaned = identifyOrphanedSDKFiles(files, activeIds, archivedIds);

      expect(orphaned).toHaveLength(2);
      const sdkIds = orphaned.map((o) => o.sdkSessionId);
      expect(sdkIds).toContain('orphan');
      expect(sdkIds).toContain('unknown');
    });
  });

  describe('removeToolResultFromSessionFile', () => {
    test('should return false when SDK session file does not exist', () => {
      const result = removeToolResultFromSessionFile(
        testWorkspacePath,
        'nonexistent-sdk-session-id',
        'message-uuid-123'
      );

      expect(result).toBe(false);
    });

    test('should return false when neither sdkSessionId nor kaiSessionId provided', () => {
      const result = removeToolResultFromSessionFile(testWorkspacePath, null, 'message-uuid-123');

      expect(result).toBe(false);
    });

    test('should return false when kaiSessionId search finds no files', () => {
      const result = removeToolResultFromSessionFile(
        testWorkspacePath,
        null,
        'message-uuid-123',
        'nonexistent-hyperneo-session-id'
      );

      expect(result).toBe(false);
    });

    test('should return false when message UUID is not found in file', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'other-uuid',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Hello' }],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = removeToolResultFromSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'nonexistent-message-uuid'
      );

      expect(result).toBe(false);
    });

    test('should return false when message has no tool_result blocks', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'target-uuid',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Hello' }],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = removeToolResultFromSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'target-uuid'
      );

      expect(result).toBe(false);
    });

    test('should successfully remove tool_result content from message', () => {
      const messages = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-uuid',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-123', name: 'Bash', input: { command: 'ls' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'user-uuid-with-result',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-123',
                content: 'Very large output that we want to remove...',
              },
            ],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = removeToolResultFromSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'user-uuid-with-result'
      );

      expect(result).toBe(true);

      const updatedContent = readFileSync(testSessionFile, 'utf-8');
      const lines = updatedContent.split('\n').filter((l) => l.trim());
      const userMessage = JSON.parse(lines[1]);

      expect(userMessage.message.content[0].content[0].type).toBe('text');
      expect(userMessage.message.content[0].content[0].text).toContain('Output removed by user');
    });

    test('should find file by kaiSessionId when sdkSessionId is null', () => {
      const kaiSessionId = 'findable-hyperneo-session-id-12345678';

      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'target-message-uuid',
          sessionId: kaiSessionId,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-456',
                content: 'Large output to remove...',
              },
            ],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = removeToolResultFromSessionFile(
        testWorkspacePath,
        null,
        'target-message-uuid',
        kaiSessionId
      );

      expect(result).toBe(true);
    });

    test('should handle multiple tool_result blocks in same message', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'multi-result-uuid',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'First result output',
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool-2',
                content: 'Second result output',
              },
            ],
          },
        }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = removeToolResultFromSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'multi-result-uuid'
      );

      expect(result).toBe(true);

      const updatedContent = readFileSync(testSessionFile, 'utf-8');
      const lines = updatedContent.split('\n').filter((l) => l.trim());
      const userMessage = JSON.parse(lines[0]);

      expect(userMessage.message.content[0].content[0].text).toContain('Output removed by user');
      expect(userMessage.message.content[1].content[0].text).toContain('Output removed by user');
    });
  });

  describe('messageUuidExistsInSessionFile', () => {
    test('should return true when UUID exists in direct session file', () => {
      const messages = [
        JSON.stringify({ type: 'user', uuid: 'message-uuid-1' }),
        JSON.stringify({ type: 'assistant', uuid: 'message-uuid-2' }),
      ];
      writeFileSync(testSessionFile, messages.join('\n') + '\n', 'utf-8');

      const exists = messageUuidExistsInSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'kai-session-id',
        'message-uuid-2'
      );

      expect(exists).toBe(true);
    });

    test('should return false when UUID is absent from direct session file', () => {
      writeFileSync(
        testSessionFile,
        JSON.stringify({ type: 'user', uuid: 'message-uuid-1' }) + '\n',
        'utf-8'
      );

      const exists = messageUuidExistsInSessionFile(
        testWorkspacePath,
        testSdkSessionId,
        'kai-session-id',
        'missing-message-uuid'
      );

      expect(exists).toBe(false);
    });

    test('should fall back to Kai session ID lookup when sdkSessionId is unavailable', () => {
      writeFileSync(
        testSessionFile,
        [
          JSON.stringify({ type: 'system', sessionId: 'kai-session-fallback' }),
          JSON.stringify({ type: 'user', uuid: 'fallback-message-uuid' }),
        ].join('\n') + '\n',
        'utf-8'
      );

      const exists = messageUuidExistsInSessionFile(
        testWorkspacePath,
        undefined,
        'kai-session-fallback',
        'fallback-message-uuid'
      );

      expect(exists).toBe(true);
    });
  });

  describe('truncateSessionFileAtMessage', () => {
    const testTruncateWorkspacePath = '/tmp/test-workspace-sdk-truncation';
    const testTruncateSdkSessionId = 'test-sdk-session-truncation';
    const testKaiSessionId = 'test-kai-session-truncation-12345';
    let testTruncateSessionDir: string;
    let testTruncateSessionFile: string;

    beforeEach(() => {
      const projectKey = testTruncateWorkspacePath.replace(/[/.]/g, '-');
      testTruncateSessionDir = join(process.env.TEST_SDK_SESSION_DIR!, 'projects', projectKey);
      mkdirSync(testTruncateSessionDir, { recursive: true });
      testTruncateSessionFile = join(testTruncateSessionDir, `${testTruncateSdkSessionId}.jsonl`);
    });

    afterEach(() => {
      if (existsSync(testTruncateSessionDir)) {
        try {
          rmSync(testTruncateSessionDir, { recursive: true, force: true });
        } catch {}
      }
    });

    test('should return {truncated: false, linesRemoved: 0} when file does not exist (no sdkSessionId)', () => {
      const result = truncateSessionFileAtMessage(
        '/nonexistent/workspace',
        null,
        'nonexistent-kai-session',
        'message-uuid-123'
      );

      expect(result.truncated).toBe(false);
      expect(result.linesRemoved).toBe(0);
    });

    test('should return {truncated: false, linesRemoved: 0} when file does not exist (nonexistent workspace)', () => {
      const result = truncateSessionFileAtMessage(
        '/nonexistent/workspace',
        'nonexistent-sdk-session',
        'kai-session-id',
        'message-uuid-123'
      );

      expect(result.truncated).toBe(false);
      expect(result.linesRemoved).toBe(0);
    });

    test('should return {truncated: false, linesRemoved: 0} when UUID is not found in file', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'message-uuid-1',
          message: { role: 'user', content: [{ type: 'text', text: 'First message' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'message-uuid-2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Second message' }] },
        }),
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = truncateSessionFileAtMessage(
        testTruncateWorkspacePath,
        testTruncateSdkSessionId,
        testKaiSessionId,
        'nonexistent-uuid-999'
      );

      expect(result.truncated).toBe(false);
      expect(result.linesRemoved).toBe(0);

      const content = readFileSync(testTruncateSessionFile, 'utf-8');
      expect(content.split('\n').filter((l) => l.trim())).toHaveLength(2);
    });

    test('should truncate file at message with exact UUID format `"uuid":"<uuid>"`', () => {
      const messages = [
        JSON.stringify({
          type: 'user',
          uuid: 'message-uuid-1',
          message: { role: 'user', content: [{ type: 'text', text: 'First message' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'message-uuid-2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Second message' }] },
        }),
        JSON.stringify({
          type: 'user',
          uuid: 'message-uuid-3',
          message: { role: 'user', content: [{ type: 'text', text: 'Third message' }] },
        }),
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = truncateSessionFileAtMessage(
        testTruncateWorkspacePath,
        testTruncateSdkSessionId,
        testKaiSessionId,
        'message-uuid-2'
      );

      expect(result.truncated).toBe(true);
      expect(result.linesRemoved).toBe(3);

      const content = readFileSync(testTruncateSessionFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(1);
      const msg = JSON.parse(lines[0]);
      expect(msg.uuid).toBe('message-uuid-1');
    });

    test('should truncate file at message with spaced UUID format `"uuid": "<uuid>"`', () => {
      const messages = [
        JSON.stringify({ type: 'user', uuid: 'message-uuid-1', message: { role: 'user' } }).replace(
          '"uuid":"message-uuid-1"',
          '"uuid": "message-uuid-1"'
        ),
        JSON.stringify({
          type: 'assistant',
          uuid: 'message-uuid-2',
          message: { role: 'assistant' },
        }),
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = truncateSessionFileAtMessage(
        testTruncateWorkspacePath,
        testTruncateSdkSessionId,
        testKaiSessionId,
        'message-uuid-1'
      );

      expect(result.truncated).toBe(true);
      expect(result.linesRemoved).toBe(3);

      const content = readFileSync(testTruncateSessionFile, 'utf-8');
      expect(content).toBe('');
    });

    test('should fall back to loose UUID match when exact match fails', () => {
      const messages = [
        JSON.stringify({ type: 'user', uuid: 'message-uuid-1' }),
        '{"type":"user","customField":"message-uuid-special","message":{}}',
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = truncateSessionFileAtMessage(
        testTruncateWorkspacePath,
        testTruncateSdkSessionId,
        testKaiSessionId,
        'message-uuid-special'
      );

      expect(result.truncated).toBe(true);
      expect(result.linesRemoved).toBe(2);

      const content = readFileSync(testTruncateSessionFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(1);
    });

    test('should preserve all lines before the truncation point', () => {
      const messages = [
        JSON.stringify({ type: 'user', uuid: 'msg-1', message: { content: 'First' } }),
        JSON.stringify({ type: 'assistant', uuid: 'msg-2', message: { content: 'Second' } }),
        JSON.stringify({ type: 'user', uuid: 'msg-3', message: { content: 'Third' } }),
        JSON.stringify({ type: 'assistant', uuid: 'msg-4', message: { content: 'Fourth' } }),
        JSON.stringify({ type: 'user', uuid: 'msg-5', message: { content: 'Fifth' } }),
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = truncateSessionFileAtMessage(
        testTruncateWorkspacePath,
        testTruncateSdkSessionId,
        testKaiSessionId,
        'msg-4'
      );

      expect(result.truncated).toBe(true);

      const content = readFileSync(testTruncateSessionFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(3);

      const uuids = lines.map((line) => JSON.parse(line).uuid);
      expect(uuids).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    test('should result in empty file content when truncating at first message', () => {
      const messages = [
        JSON.stringify({ type: 'user', uuid: 'first-msg', message: { content: 'First' } }),
        JSON.stringify({ type: 'assistant', uuid: 'second-msg', message: { content: 'Second' } }),
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n', 'utf-8');

      const result = truncateSessionFileAtMessage(
        testTruncateWorkspacePath,
        testTruncateSdkSessionId,
        testKaiSessionId,
        'first-msg'
      );

      expect(result.truncated).toBe(true);
      expect(result.linesRemoved).toBe(3);

      const content = readFileSync(testTruncateSessionFile, 'utf-8');
      expect(content).toBe('');
    });

    test('should handle file with trailing empty lines correctly', () => {
      const messages = [
        JSON.stringify({ type: 'user', uuid: 'msg-1', message: { content: 'First' } }),
        JSON.stringify({ type: 'assistant', uuid: 'msg-2', message: { content: 'Second' } }),
        JSON.stringify({ type: 'user', uuid: 'msg-3', message: { content: 'Third' } }),
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n\n\n', 'utf-8');

      const result = truncateSessionFileAtMessage(
        testTruncateWorkspacePath,
        testTruncateSdkSessionId,
        testKaiSessionId,
        'msg-3'
      );

      expect(result.truncated).toBe(true);
      expect(result.linesRemoved).toBeGreaterThan(0);

      const content = readFileSync(testTruncateSessionFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).uuid).toBe('msg-1');
      expect(JSON.parse(lines[1]).uuid).toBe('msg-2');
    });

    test('should return correct linesRemoved count', () => {
      const messages = [
        JSON.stringify({ type: 'user', uuid: 'msg-1' }),
        JSON.stringify({ type: 'assistant', uuid: 'msg-2' }),
        JSON.stringify({ type: 'user', uuid: 'msg-3' }),
        JSON.stringify({ type: 'assistant', uuid: 'msg-4' }),
        JSON.stringify({ type: 'user', uuid: 'msg-5' }),
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n', 'utf-8');

      const originalContent = readFileSync(testTruncateSessionFile, 'utf-8');
      const originalLines = originalContent.split('\n');

      const result = truncateSessionFileAtMessage(
        testTruncateWorkspacePath,
        testTruncateSdkSessionId,
        testKaiSessionId,
        'msg-3'
      );

      expect(result.truncated).toBe(true);
      expect(result.linesRemoved).toBe(originalLines.length - 2);

      const newContent = readFileSync(testTruncateSessionFile, 'utf-8');
      const newLines = newContent.split('\n').filter((l) => l.trim());
      expect(newLines).toHaveLength(2);
    });

    test.skip('should handle errors gracefully (read-only file scenario)', () => {
      const messages = [
        JSON.stringify({ type: 'user', uuid: 'msg-1' }),
        JSON.stringify({ type: 'assistant', uuid: 'msg-2' }),
      ];
      writeFileSync(testTruncateSessionFile, messages.join('\n') + '\n', 'utf-8');

      try {
        const fs = require('node:fs');
        fs.chmodSync(testTruncateSessionFile, 0o444);

        const result = truncateSessionFileAtMessage(
          testTruncateWorkspacePath,
          testTruncateSdkSessionId,
          testKaiSessionId,
          'msg-2'
        );

        expect(result.truncated).toBe(false);
        expect(result.linesRemoved).toBe(0);
      } finally {
        try {
          const fs = require('node:fs');
          fs.chmodSync(testTruncateSessionFile, 0o644);
        } catch {}
      }
    });
  });

  describe('findSDKSessionFileGlobally', () => {
    test('should return null when projects directory does not exist', () => {
      const result = findSDKSessionFileGlobally('nonexistent-session-id');
      expect(result).toBeNull();
    });

    test('should return null when no project directory contains the session file', () => {
      mkdirSync(join(process.env.TEST_SDK_SESSION_DIR!, 'projects', '-some-project'), {
        recursive: true,
      });
      const result = findSDKSessionFileGlobally('session-not-here');
      expect(result).toBeNull();
    });

    test('should find a session file stored under a different workspace path', () => {
      const workspaceA = '/tmp/workspace-a';
      const sessionId = 'resume-test-session-id';
      const projectKeyA = workspaceA.replace(/[/.]/g, '-');
      const projectDirA = join(process.env.TEST_SDK_SESSION_DIR!, 'projects', projectKeyA);
      mkdirSync(projectDirA, { recursive: true });
      const filePath = join(projectDirA, `${sessionId}.jsonl`);
      writeFileSync(filePath, JSON.stringify({ type: 'user', uuid: 'u1' }) + '\n', 'utf-8');

      const result = findSDKSessionFileGlobally(sessionId);

      expect(result).toBe(filePath);
    });

    test('should return null for a non-existent session id', () => {
      const projectDir = join(process.env.TEST_SDK_SESSION_DIR!, 'projects', '-tmp-workspace-c');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'other-session.jsonl'), '{}', 'utf-8');

      const result = findSDKSessionFileGlobally('completely-different-session-id');
      expect(result).toBeNull();
    });
  });

  describe('migrateSDKSessionFile', () => {
    const sessionId = 'migrate-test-session';
    const workspaceA = '/tmp/migrate-workspace-a';
    const workspaceB = '/tmp/migrate-workspace-b';

    test('should copy session file from source workspace to target workspace', () => {
      const fileA = getSDKSessionFilePath(workspaceA, sessionId);
      mkdirSync(join(fileA, '..'), { recursive: true });
      writeFileSync(fileA, JSON.stringify({ type: 'user' }) + '\n', 'utf-8');

      const success = migrateSDKSessionFile(workspaceA, workspaceB, sessionId);

      expect(success).toBe(true);

      const fileB = getSDKSessionFilePath(workspaceB, sessionId);
      expect(existsSync(fileB)).toBe(true);

      expect(existsSync(fileA)).toBe(true);

      const contentB = readFileSync(fileB, 'utf-8');
      expect(contentB).toContain('"type":"user"');
    });

    test('should return false when source file does not exist', () => {
      const success = migrateSDKSessionFile('/tmp/nonexistent-workspace', workspaceB, sessionId);
      expect(success).toBe(false);
    });

    test('should return true without copying when source and target resolve to same path', () => {
      const fileA = getSDKSessionFilePath(workspaceA, sessionId);
      mkdirSync(join(fileA, '..'), { recursive: true });
      writeFileSync(fileA, '{}', 'utf-8');

      const success = migrateSDKSessionFile(workspaceA, workspaceA, sessionId);
      expect(success).toBe(true);
    });

    test('should return true without error when target file already exists', () => {
      const fileA = getSDKSessionFilePath(workspaceA, sessionId);
      const fileB = getSDKSessionFilePath(workspaceB, sessionId);
      mkdirSync(join(fileA, '..'), { recursive: true });
      mkdirSync(join(fileB, '..'), { recursive: true });
      writeFileSync(fileA, '{"type":"old"}', 'utf-8');
      writeFileSync(fileB, '{"type":"existing"}', 'utf-8');

      const success = migrateSDKSessionFile(workspaceA, workspaceB, sessionId);
      expect(success).toBe(true);

      const content = readFileSync(fileB, 'utf-8');
      expect(content).toContain('"type":"existing"');
    });
  });
});
