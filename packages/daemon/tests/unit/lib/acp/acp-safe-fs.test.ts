import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
  readFileWithinWorkspace,
  writeFileWithinWorkspace,
} from '../../../../src/lib/acp/acp-safe-fs';

const bunRuntimeTest = process.versions.bun && isSafeFsSupported() ? test : test.skip;
const unsupportedRuntimeTest = process.versions.bun ? test.skip : test;

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
    const written = join(workspace, 'nested', 'written.txt');
    expect(await readFile(written, 'utf-8')).toBe('written');
    expect((await stat(written)).mode & 0o777).toBe(0o600);

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

bunRuntimeTest('rejects oversized writes before modifying the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-size-'));
  const workspace = join(root, 'workspace');
  const target = join(workspace, 'content.txt');
  await mkdir(workspace);
  await writeFile(target, 'original');

  try {
    await expect(
      writeFileWithinWorkspace(
        workspace,
        ['content.txt'],
        'x'.repeat(4 * 1024 * 1024 + 1),
        new AbortController().signal
      )
    ).rejects.toThrow('ACP filesystem write exceeds 4194304 bytes');
    expect(await readFile(target, 'utf-8')).toBe('original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('writes maximum-length filenames through a short temporary name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-name-'));
  const workspace = join(root, 'workspace');
  const fileName = 'x'.repeat(255);
  await mkdir(workspace);

  try {
    await writeFileWithinWorkspace(workspace, [fileName], 'content', new AbortController().signal);
    expect(await readFile(join(workspace, fileName), 'utf-8')).toBe('content');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('preserves mode 755 when replacing an existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-mode-'));
  const workspace = join(root, 'workspace');
  const target = join(workspace, 'script.sh');
  await mkdir(workspace);
  await writeFile(target, 'original');
  await chmod(target, 0o755);

  try {
    await writeFileWithinWorkspace(
      workspace,
      ['script.sh'],
      'replacement',
      new AbortController().signal
    );
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('preserves mode 0 when replacing an existing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-mode-'));
  const workspace = join(root, 'workspace');
  const target = join(workspace, 'script.sh');
  await mkdir(workspace);
  await writeFile(target, 'original');
  await chmod(target, 0o000);

  try {
    await writeFileWithinWorkspace(
      workspace,
      ['script.sh'],
      'replacement',
      new AbortController().signal
    );
    expect((await stat(target)).mode & 0o777).toBe(0o000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('replaces workspace hard links without modifying the linked file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-hardlink-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  const target = join(workspace, 'linked.txt');
  await mkdir(workspace);
  await writeFile(outside, 'outside');
  await link(outside, target);

  try {
    await writeFileWithinWorkspace(
      workspace,
      ['linked.txt'],
      'workspace',
      new AbortController().signal
    );
    expect(await readFile(target, 'utf-8')).toBe('workspace');
    expect(await readFile(outside, 'utf-8')).toBe('outside');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('replaces a final symlink without following it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-write-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  const target = join(workspace, 'link.txt');
  await mkdir(workspace);
  await symlink(outside, target);

  try {
    await writeFileWithinWorkspace(
      workspace,
      ['link.txt'],
      'workspace',
      new AbortController().signal
    );
    expect(await readFile(target, 'utf-8')).toBe('workspace');
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

bunRuntimeTest('rejects path segments containing path separators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-sep-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);

  try {
    for (const segments of [
      ['../outside.txt'],
      ['/tmp/outside.txt'],
      ['nested', 'sub/file.txt'],
      ['..', 'outside.txt'],
      ['.', 'outside.txt'],
    ]) {
      await expect(
        readFileWithinWorkspace(workspace, segments, {
          startLine: 0,
          lineLimit: undefined,
          maxBytes: 1024,
        })
      ).rejects.toThrow('Unable to access ACP filesystem path');
    }
    await expect(
      writeFileWithinWorkspace(
        workspace,
        ['../outside.txt'],
        'blocked',
        new AbortController().signal
      )
    ).rejects.toThrow('Unable to access ACP filesystem path');
    await expect(readFile(join(root, 'outside.txt'), 'utf-8')).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('does not charge trailing bytes to the scan budget of a bounded range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-range-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'content.txt'), `ok\n${'x'.repeat(128 * 1024)}`);

  try {
    expect(
      await readFileWithinWorkspace(workspace, ['content.txt'], {
        startLine: 0,
        lineLimit: 1,
        maxBytes: 3,
      })
    ).toBe('ok\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('opens a symlinked workspace root without following segment symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-root-'));
  const real = join(root, 'real');
  const workspace = join(root, 'workspace');
  await mkdir(join(real, 'nested'), { recursive: true });
  await symlink(real, workspace);

  try {
    await writeFileWithinWorkspace(
      workspace,
      ['nested', 'written.txt'],
      'written',
      new AbortController().signal
    );
    expect(await readFile(join(real, 'nested', 'written.txt'), 'utf-8')).toBe('written');
    expect(
      await readFileWithinWorkspace(workspace, ['nested', 'written.txt'], {
        startLine: 0,
        lineLimit: undefined,
        maxBytes: 1024,
      })
    ).toBe('written');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('reads whole files exactly at the byte cap and rejects beyond it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-cap-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'content.txt'), 'abc');
  await writeFile(join(workspace, 'large.txt'), 'abcd');

  try {
    expect(
      await readFileWithinWorkspace(workspace, ['content.txt'], {
        startLine: 0,
        lineLimit: undefined,
        maxBytes: 3,
      })
    ).toBe('abc');
    await expect(
      readFileWithinWorkspace(workspace, ['large.txt'], {
        startLine: 0,
        lineLimit: undefined,
        maxBytes: 3,
      })
    ).rejects.toThrow('ACP filesystem scan exceeds 3 bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

bunRuntimeTest('applies the preserved mode regardless of the process umask', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-umask-'));
  const workspace = join(root, 'workspace');
  const target = join(workspace, 'guarded.txt');
  await mkdir(workspace);
  await writeFile(target, 'original');
  await chmod(target, 0o600);

  const previousUmask = process.umask(0o777);
  try {
    await writeFileWithinWorkspace(
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
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-umask-dir-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);

  const previousUmask = process.umask(0o777);
  try {
    await writeFileWithinWorkspace(
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
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-parents-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);

  try {
    await writeFileWithinWorkspace(
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
  const root = await mkdtemp(join(tmpdir(), 'hyperneo-acp-safe-fds-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'nested'), { recursive: true });

  try {
    await writeFileWithinWorkspace(
      workspace,
      ['nested', 'written.txt'],
      'content',
      new AbortController().signal
    );
    const descriptors = readdirSync('/dev/fd').length;
    await writeFileWithinWorkspace(
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
    await writeFileWithinWorkspace(
      workspace,
      ['pipe'],
      'replacement',
      new AbortController().signal
    );
    const replacement = join(workspace, 'pipe');
    expect(await readFile(replacement, 'utf-8')).toBe('replacement');
    expect((await stat(replacement)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
