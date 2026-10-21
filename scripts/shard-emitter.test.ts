import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const helper = resolve('scripts/lib/shard-split.sh');

test('shard enumeration stays bounded when per-file checksum processes are slow', () => {
  const root = mkdtempSync(join(tmpdir(), 'shard-emitter-'));
  try {
    mkdirSync(join(root, 'fixture'));
    mkdirSync(join(root, 'bin'));
    for (let index = 0; index < 128; index++) {
      writeFileSync(join(root, 'fixture', `${index}.test.ts`), '');
    }
    writeFileSync(join(root, 'bin', 'cksum'), '#!/bin/sh\nsleep 0.03\nexec /usr/bin/cksum "$@"\n');
    chmodSync(join(root, 'bin', 'cksum'), 0o755);
    const result = spawnSync(
      'bash',
      [
        '-c',
        'source "$1"; shard_split_bucket "$2" 1 0 "$2/fixture/*.test.ts"',
        'shard-test',
        helper,
        root,
      ],
      {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
        encoding: 'utf8',
        timeout: 2000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const paths = result.stdout.trim().split('\n');
    expect(new Set(paths).size).toBe(128);
    expect(paths.every((path) => path.startsWith(`${root}/fixture/`))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test('shard hashes match POSIX cksum for UTF-8 and multi-byte lengths', () => {
  const root = mkdtempSync(join(tmpdir(), 'shard-checksum-'));
  try {
    const paths = [
      'a.test.ts',
      '中文.test.ts',
      `${'a'.repeat(120)}/${'b'.repeat(120)}/long.test.ts`,
    ];
    for (const path of paths) {
      const full = join(root, path);
      mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, '');
    }
    const output = execFileSync(
      'bash',
      [
        '-c',
        'source "$1"; shift; root="$1"; shift; __shard_emit "$root" "$@"',
        'shard-test',
        helper,
        root,
        ...paths.map((path) => join(root, path)),
      ],
      { encoding: 'utf8' }
    );
    const expected = paths
      .map((path) => {
        const checksum = execFileSync('cksum', [], { input: path, encoding: 'utf8' }).split(' ')[0];
        return `${checksum.padStart(10, '0')}\t${path}\n`;
      })
      .join('');
    expect(output).toBe(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
