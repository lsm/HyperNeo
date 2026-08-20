import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileWithinWorkspace } from '../../../../src/lib/acp/acp-safe-fs';

test('writes through workspace directories without following symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-write-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  await mkdir(outside);

  try {
    await writeFileWithinWorkspace(
      workspace,
      ['nested', 'written.txt'],
      'written',
      new AbortController().signal
    );
    expect(await readFile(join(workspace, 'nested', 'written.txt'), 'utf-8')).toBe('written');

    await rename(join(workspace, 'nested'), join(workspace, 'moved'));
    await symlink(outside, join(workspace, 'nested'));

    await expect(
      writeFileWithinWorkspace(
        workspace,
        ['nested', 'escaped.txt'],
        'blocked',
        new AbortController().signal
      )
    ).rejects.toThrow('Unable to open ACP filesystem path');
    await expect(readFile(join(outside, 'escaped.txt'), 'utf-8')).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not follow a final symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-write-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  await mkdir(workspace);
  await symlink(outside, join(workspace, 'link.txt'));

  try {
    await expect(
      writeFileWithinWorkspace(workspace, ['link.txt'], 'blocked', new AbortController().signal)
    ).rejects.toThrow('Unable to open ACP filesystem path');
    await expect(readFile(outside, 'utf-8')).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
