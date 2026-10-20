import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from '../../../../src/storage/database';
import {
  getSDKSessionFilePath,
  truncateSessionFileAtMessage,
  validateAndRepairSDKSession,
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

  test('a later pass reads only the lines appended since the last one', async () => {
    const pair = use('t') + result('t', 2_000);
    writeFileSync(file, '');
    for (let i = 0; i < 20; i++) appendFileSync(file, pair.replaceAll('"t"', `"t${i}"`));
    expect(await validateSDKSessionFile(workspace, 's1')).toEqual({
      valid: true,
      orphanedToolResults: [],
      errors: [],
    });

    const text = readFileSync(file, 'utf8');
    const middle = text.lastIndexOf('\n', text.indexOf('"tool_use_id":"t10"')) + 1;
    expect(middle).toBeGreaterThan(1_000);
    const fd = openSync(file, 'r+');
    writeSync(fd, 'X', middle);
    closeSync(fd);
    appendFileSync(file, result('missing'));
    expect(await validateSDKSessionFile(workspace, 's1')).toEqual({
      valid: false,
      orphanedToolResults: [{ toolUseId: 'missing', messageUuid: 'u-missing', lineIndex: 40 }],
      errors: [],
    });

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

  test('keeps state for the 64 most recently validated transcripts and rereads an evicted one in full', async () => {
    writeFileSync(file, use('a') + result('a'));
    await validateSDKSessionFile(workspace, 's1');
    for (let i = 0; i < 64; i++) {
      const other = getSDKSessionFilePath(workspace, `o${i}`);
      writeFileSync(other, use('x'));
      await validateSDKSessionFile(workspace, `o${i}`);
    }
    writeFileSync(file, use('b') + result('a') + result('b'));
    expect((await validateSDKSessionFile(workspace, 's1')).orphanedToolResults).toEqual([
      { toolUseId: 'a', messageUuid: 'u-a', lineIndex: 1 },
    ]);
  });

  test('a rewrite through this module during a scan is not cached as a mix of old and new content', async () => {
    writeFileSync(file, '');
    for (let i = 0; i < 60; i++) appendFileSync(file, use(`k${i}`) + result(`k${i}`, 200_000));
    appendFileSync(file, use('late') + result('late'));
    const scan = validateSDKSessionFile(workspace, 's1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    truncateSessionFileAtMessage(workspace, 's1', 'kai', 'a-k30');
    await scan;
    appendFileSync(file, result('k40'));
    expect((await validateSDKSessionFile(workspace, 's1')).orphanedToolResults).toEqual([
      { toolUseId: 'k40', messageUuid: 'u-k40', lineIndex: 60 },
    ]);
  });

  test('an unterminated last line counts now and is not counted twice once it ends', async () => {
    writeFileSync(file, use('a') + result('z').trimEnd());
    expect((await validateSDKSessionFile(workspace, 's1')).valid).toBe(false);
    appendFileSync(file, '\n');
    expect((await validateSDKSessionFile(workspace, 's1')).orphanedToolResults).toHaveLength(1);
  });

  describe('validateAndRepairSDKSession', () => {
    test('concurrent validate-and-repair calls for one transcript share a single run', async () => {
      writeFileSync(file, use('a') + result('a'));
      const db = {} as Database;
      const first = validateAndRepairSDKSession(workspace, 's1', 'kai', db);
      const second = validateAndRepairSDKSession(workspace, 's1', 'kai', db);
      expect(second).toBe(first);
      expect(await first).toBe(true);
      expect(validateAndRepairSDKSession(workspace, 's1', 'kai', db)).not.toBe(first);
    });
  });
});
