import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripDisallowedBlockKeys } from '../../../../src/lib/content-block-keys';
import { stripThinkingBlocksFromSessionFile } from '../../../../src/lib/sdk-session-file-manager';

const toolUse = {
  type: 'tool_use',
  id: 'toolu_1',
  name: 'Bash',
  input: { command: 'ls' },
  cache_control: { type: 'ephemeral' },
};

describe('stripDisallowedBlockKeys', () => {
  test('drops keys the Anthropic API rejects on a tool_use block', () => {
    expect(stripDisallowedBlockKeys({ ...toolUse, text: '', thinking: 'planning' })).toEqual(
      toolUse
    );
  });

  test('returns an allowed tool_use block and other block types unchanged', () => {
    const text = { type: 'text', text: 'hi', citations: [] };
    expect(stripDisallowedBlockKeys(toolUse)).toBe(toolUse);
    expect(stripDisallowedBlockKeys(text)).toBe(text);
  });
});

describe('stripThinkingBlocksFromSessionFile', () => {
  const workspace = '/tmp/test-workspace-block-keys';
  const sdkSessionId = 'block-keys-session';
  let file: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.TEST_SDK_SESSION_DIR;
    const root = join(
      process.env.TMPDIR || '/tmp/claude',
      `sdk-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.TEST_SDK_SESSION_DIR = root;
    const dir = join(root, 'projects', workspace.replace(/[/.]/g, '-'));
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${sdkSessionId}.jsonl`);
  });

  afterEach(() => {
    const root = process.env.TEST_SDK_SESSION_DIR;
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.TEST_SDK_SESSION_DIR;
    else process.env.TEST_SDK_SESSION_DIR = previous;
  });

  test('a provider switch leaves tool_use history the new provider accepts', () => {
    writeFileSync(
      file,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Listing.' },
            { ...toolUse, text: '', thinking: 'x' },
          ],
        },
      })}\n`,
      'utf-8'
    );

    expect(stripThinkingBlocksFromSessionFile(workspace, sdkSessionId).stripped).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf-8').trim());
    expect(saved.message.content).toEqual([{ type: 'text', text: 'Listing.' }, toolUse]);
  });
});
