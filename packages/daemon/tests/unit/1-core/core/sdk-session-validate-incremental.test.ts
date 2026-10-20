import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSDKSessionFilePath,
  validateSDKSessionFile,
} from '../../../../src/lib/sdk-session-file-manager';

const use = (id: string) =>
  `${JSON.stringify({ type: 'assistant', uuid: `a-${id}`, message: { content: [{ type: 'tool_use', id }] } })}\n`;
const result = (id: string, size = 0) =>
  `${JSON.stringify({ type: 'user', uuid: `u-${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(size) }] } })}\n`;

describe('validateSDKSessionFile', () => {
  let root: string;
  let file: string;
  const workspace = '/tmp/validate-incremental-ws';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sdk-validate-'));
    process.env.TEST_SDK_SESSION_DIR = root;
    file = getSDKSessionFilePath(workspace, 's1');
    mkdirSync(join(file, '..'), { recursive: true });
  });
  afterEach(() => {
    delete process.env.TEST_SDK_SESSION_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test('a long transcript is checked without holding it in memory, then only its new lines are read', async () => {
    const pair = use('t') + result('t', 200_000);
    writeFileSync(file, '');
    for (let i = 0; i < 1_500; i++) appendFileSync(file, pair.replaceAll('"t"', `"t${i}"`));
    const before = process.memoryUsage().heapUsed;
    expect((await validateSDKSessionFile(workspace, 's1')).valid).toBe(true);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(120 * 1024 * 1024);

    appendFileSync(file, result('missing'));
    const started = performance.now();
    const next = await validateSDKSessionFile(workspace, 's1');
    expect(performance.now() - started).toBeLessThan(50);
    expect(next.orphanedToolResults).toEqual([
      { toolUseId: 'missing', messageUuid: 'u-missing', lineIndex: 3_000 },
    ]);

    appendFileSync(file, use('missing'));
    expect((await validateSDKSessionFile(workspace, 's1')).valid).toBe(true);
  });

  test('a transcript rewritten in place is validated again from the start', async () => {
    writeFileSync(file, use('a') + result('a'));
    expect((await validateSDKSessionFile(workspace, 's1')).valid).toBe(true);
    writeFileSync(file, use('b') + result('a') + result('b'));
    expect((await validateSDKSessionFile(workspace, 's1')).orphanedToolResults).toEqual([
      { toolUseId: 'a', messageUuid: 'u-a', lineIndex: 1 },
    ]);
  });

  test('a deleted transcript is forgotten, so a new file at the same path is validated from the start', async () => {
    writeFileSync(file, use('a') + result('a'));
    expect((await validateSDKSessionFile(workspace, 's1')).valid).toBe(true);
    rmSync(file);
    expect((await validateSDKSessionFile(workspace, 's1')).valid).toBe(true);
    writeFileSync(file, use('a') + result('a') + result('b'));
    expect((await validateSDKSessionFile(workspace, 's1')).orphanedToolResults).toEqual([
      { toolUseId: 'b', messageUuid: 'u-b', lineIndex: 2 },
    ]);
  });

  test('an unterminated last line counts now and is not counted twice once it ends', async () => {
    writeFileSync(file, use('a') + result('z').trimEnd());
    expect((await validateSDKSessionFile(workspace, 's1')).valid).toBe(false);
    appendFileSync(file, '\n');
    expect((await validateSDKSessionFile(workspace, 's1')).orphanedToolResults).toHaveLength(1);
  });
});
