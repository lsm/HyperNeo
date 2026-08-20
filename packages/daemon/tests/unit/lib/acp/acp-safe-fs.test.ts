import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFileWithinWorkspace,
  writeFileWithinWorkspace,
} from '../../../../src/lib/acp/acp-safe-fs';

const bunRuntimeTest = process.versions.bun ? test : test.skip;
const unsupportedRuntimeTest = process.versions.bun ? test.skip : test;

unsupportedRuntimeTest('rejects filesystem operations only when invoked', async () => {
  const signal = new AbortController().signal;

  await expect(
    readFileWithinWorkspace('/workspace', ['content.txt'], {
      startLine: 0,
      lineLimit: undefined,
      maxBytes: 1024,
    })
  ).rejects.toThrow(`ACP safe filesystem operations are unavailable on ${process.platform}`);
  await expect(
    writeFileWithinWorkspace('/workspace', ['content.txt'], 'content', signal)
  ).rejects.toThrow(`ACP safe filesystem operations are unavailable on ${process.platform}`);
});

bunRuntimeTest('writes through workspace directories without following symlinks', async () => {
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

bunRuntimeTest('does not follow a final symlink', async () => {
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

bunRuntimeTest('reads exact ranged content without following symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-read-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(workspace, 'nested', 'content.txt'), 'one\r\ntwo\r\nthree\r\n');
  await writeFile(join(outside, 'secret.txt'), 'secret');

  try {
    expect(
      await readFileWithinWorkspace(workspace, ['nested', 'content.txt'], {
        startLine: 1,
        lineLimit: 1,
        maxBytes: 1024,
      })
    ).toBe('two\r\n');

    await rename(join(workspace, 'nested'), join(workspace, 'moved'));
    await symlink(outside, join(workspace, 'nested'));

    await expect(
      readFileWithinWorkspace(workspace, ['nested', 'secret.txt'], {
        startLine: 0,
        lineLimit: undefined,
        maxBytes: 1024,
      })
    ).rejects.toThrow('Unable to open ACP filesystem path');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('does not follow a final read symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-read-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  await mkdir(workspace);
  await writeFile(outside, 'secret');
  await symlink(outside, join(workspace, 'link.txt'));

  try {
    await expect(
      readFileWithinWorkspace(workspace, ['link.txt'], {
        startLine: 0,
        lineLimit: undefined,
        maxBytes: 1024,
      })
    ).rejects.toThrow('Unable to open ACP filesystem path');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('rejects path segments containing NUL bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-nul-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);

  try {
    await expect(
      readFileWithinWorkspace(workspace, ['..\0ignored', 'secret.txt'], {
        startLine: 0,
        lineLimit: undefined,
        maxBytes: 1024,
      })
    ).rejects.toThrow('Unable to access ACP filesystem path');
    await expect(
      writeFileWithinWorkspace(
        workspace,
        ['..\0ignored', 'secret.txt'],
        'blocked',
        new AbortController().signal
      )
    ).rejects.toThrow('Unable to access ACP filesystem path');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('bounds bytes scanned before the requested line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-scan-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'content.txt'), `${'x'.repeat(64 * 1024)}\ntarget\n`);

  try {
    await expect(
      readFileWithinWorkspace(workspace, ['content.txt'], {
        startLine: 1,
        lineLimit: 1,
        maxBytes: 64 * 1024,
      })
    ).rejects.toThrow('ACP filesystem scan exceeds 65536 bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('rejects named pipes without blocking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-fifo-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  execFileSync('mkfifo', [join(workspace, 'pipe')]);

  try {
    await expect(
      readFileWithinWorkspace(workspace, ['pipe'], {
        startLine: 0,
        lineLimit: undefined,
        maxBytes: 1024,
      })
    ).rejects.toThrow('Unable to read ACP filesystem path');
    await expect(
      writeFileWithinWorkspace(workspace, ['pipe'], 'blocked', new AbortController().signal)
    ).rejects.toThrow('Unable to open ACP filesystem path');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
