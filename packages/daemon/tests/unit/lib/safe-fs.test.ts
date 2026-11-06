import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeStatMode,
  isSafeFsSupported,
  locateStatModeOffset,
  replaceFileWithinWorkspace,
} from '../../../src/lib/safe-fs';

const bunRuntimeTest = process.versions.bun && isSafeFsSupported() ? test : test.skip;

const writeWorkspaceFile = (
  workspace: string,
  segments: string[],
  content: string,
  signal: AbortSignal
) => replaceFileWithinWorkspace(workspace, segments, Buffer.from(content), signal);

test('reports an aborted replacement using the workspace filesystem error', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    replaceFileWithinWorkspace(
      '/synthetic/workspace',
      ['result'],
      Buffer.from('text'),
      controller.signal
    )
  ).rejects.toThrow('workspace filesystem write cancelled');
});

test('decodes regular-file mode bits from a stat buffer', () => {
  const buf = Buffer.alloc(256);
  buf.writeUInt16LE(0o100400, 8);
  expect(decodeStatMode(buf, 8, 2)).toBe(0o400);
  buf.writeUInt16LE(0o100644, 8);
  expect(decodeStatMode(buf, 8, 2)).toBe(0o644);
  buf.writeUInt16LE(0o100000, 8);
  expect(decodeStatMode(buf, 8, 2)).toBe(0o000);
});

test('decodes 32-bit mode values from a stat buffer', () => {
  const buf = Buffer.alloc(256);
  buf.writeUInt32LE(0o100400, 16);
  expect(decodeStatMode(buf, 16, 4)).toBe(0o400);
});

test('returns the pinned mode for non-regular stat entries', () => {
  const buf = Buffer.alloc(256);
  buf.writeUInt16LE(0o40700, 8);
  expect(decodeStatMode(buf, 8, 2)).toBe(0o600);
  buf.writeUInt16LE(0o120400, 8);
  expect(decodeStatMode(buf, 8, 2)).toBe(0o600);
});

test('locates the mode offset within a calibration buffer', () => {
  const buf = Buffer.alloc(256);
  buf.writeUInt16LE(0o40700, 8);
  expect(locateStatModeOffset(buf, 0o40700, 4)).toBe(8);
});

test('falls back when the calibration mode is absent from the buffer', () => {
  const buf = Buffer.alloc(256);
  buf.writeUInt16LE(0o40755, 8);
  expect(locateStatModeOffset(buf, 0o40700, 4)).toBe(4);
});

test('does not scan past the end of a truncated buffer', () => {
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(0o40700, 0);
  expect(locateStatModeOffset(buf, 0o40700, 4)).toBe(0);
  expect(locateStatModeOffset(Buffer.alloc(2), 0o40700, 8)).toBe(8);
});

bunRuntimeTest('writes through workspace directories without following symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-write-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'nested'), { recursive: true });
  await mkdir(outside);

  try {
    await writeWorkspaceFile(
      workspace,
      ['nested', 'written.txt'],
      'written',
      new AbortController().signal
    );
    const written = join(workspace, 'nested', 'written.txt');
    expect(await readFile(written, 'utf-8')).toBe('written');
    expect((await stat(written)).mode & 0o777).toBe(0o600);

    await rename(join(workspace, 'nested'), join(workspace, 'moved'));
    await symlink(outside, join(workspace, 'nested'));

    await expect(
      writeWorkspaceFile(
        workspace,
        ['nested', 'escaped.txt'],
        'blocked',
        new AbortController().signal
      )
    ).rejects.toThrow('Unable to open workspace filesystem path');
    await expect(readFile(join(outside, 'escaped.txt'), 'utf-8')).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('writes maximum-length filenames through a short temporary name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-name-'));
  const workspace = join(root, 'workspace');
  const fileName = 'x'.repeat(255);
  await mkdir(workspace);

  try {
    await writeWorkspaceFile(workspace, [fileName], 'content', new AbortController().signal);
    expect(await readFile(join(workspace, fileName), 'utf-8')).toBe('content');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('preserves mode 755 when replacing an existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-mode-'));
  const workspace = join(root, 'workspace');
  const target = join(workspace, 'script.sh');
  await mkdir(workspace);
  await writeFile(target, 'original');
  await chmod(target, 0o755);

  try {
    await writeWorkspaceFile(workspace, ['script.sh'], 'replacement', new AbortController().signal);
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('preserves mode 0 when replacing an existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-mode-'));
  const workspace = join(root, 'workspace');
  const target = join(workspace, 'script.sh');
  await mkdir(workspace);
  await writeFile(target, 'original');
  await chmod(target, 0o000);

  try {
    await writeWorkspaceFile(workspace, ['script.sh'], 'replacement', new AbortController().signal);
    expect((await stat(target)).mode & 0o777).toBe(0o000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('replaces workspace hard links without modifying the linked file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-hardlink-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  const target = join(workspace, 'linked.txt');
  await mkdir(workspace);
  await writeFile(outside, 'outside');
  await link(outside, target);

  try {
    await writeWorkspaceFile(workspace, ['linked.txt'], 'workspace', new AbortController().signal);
    expect(await readFile(target, 'utf-8')).toBe('workspace');
    expect(await readFile(outside, 'utf-8')).toBe('outside');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('replaces a final symlink without following it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-write-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  const target = join(workspace, 'link.txt');
  await mkdir(workspace);
  await symlink(outside, target);

  try {
    await writeWorkspaceFile(workspace, ['link.txt'], 'workspace', new AbortController().signal);
    expect(await readFile(target, 'utf-8')).toBe('workspace');
    await expect(readFile(outside, 'utf-8')).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('applies the preserved mode regardless of the process umask', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-umask-'));
  const workspace = join(root, 'workspace');
  const target = join(workspace, 'guarded.txt');
  await mkdir(workspace);
  await writeFile(target, 'original');
  await chmod(target, 0o600);

  const previousUmask = process.umask(0o777);
  try {
    await writeWorkspaceFile(
      workspace,
      ['guarded.txt'],
      'replacement',
      new AbortController().signal
    );
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(previousUmask);
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('creates parent directories with the pinned mode despite the umask', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-umask-dir-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);

  const previousUmask = process.umask(0o777);
  try {
    await writeWorkspaceFile(
      workspace,
      ['nested', 'created.txt'],
      'content',
      new AbortController().signal
    );
    expect(await readFile(join(workspace, 'nested', 'created.txt'), 'utf-8')).toBe('content');
    expect((await stat(join(workspace, 'nested'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(workspace, 'nested', 'created.txt'))).mode & 0o777).toBe(0o600);
  } finally {
    process.umask(previousUmask);
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('creates missing parent directories on write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-parents-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);

  try {
    await writeWorkspaceFile(
      workspace,
      ['made', 'up', 'written.txt'],
      'content',
      new AbortController().signal
    );
    expect(await readFile(join(workspace, 'made', 'up', 'written.txt'), 'utf-8')).toBe('content');
    expect((await stat(join(workspace, 'made', 'up'))).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('leaves no open descriptors after a write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-fds-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'nested'), { recursive: true });

  try {
    await writeWorkspaceFile(
      workspace,
      ['nested', 'written.txt'],
      'content',
      new AbortController().signal
    );
    const descriptors = readdirSync('/dev/fd').length;
    await writeWorkspaceFile(
      workspace,
      ['nested', 'written.txt'],
      'replacement',
      new AbortController().signal
    );
    expect(readdirSync('/dev/fd').length).toBe(descriptors);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('does not chmod a symlink parent during directory creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-safe-linkdir-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await chmod(outside, 0o755);
  await symlink(outside, join(workspace, 'link'));

  try {
    await expect(
      writeWorkspaceFile(
        workspace,
        ['link', 'escaped.txt'],
        'blocked',
        new AbortController().signal
      )
    ).rejects.toThrow('Unable to open workspace filesystem path');
    expect((await stat(outside)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
