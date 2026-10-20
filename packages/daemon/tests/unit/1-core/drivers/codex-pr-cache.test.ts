import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexPrReader } from '../../../../src/lib/drivers/opened-prs.ts';
import { readTailLines } from '../../../../src/lib/drivers/transcript-tail.ts';

const line = (number: number) =>
  `attach_artifact pull_request https://github.com/synthetic/repo/pull/${number}\n`;
const pr = (number: number) => `https://github.com/synthetic/repo/pull/${number}`;

describe('Codex PR snapshots', () => {
  test('refreshes same-size PR evidence even when the file version repeats', () => {
    const read = createCodexPrReader();
    expect(read('rollout.jsonl', 'same-file-version', [line(1)])).toEqual([pr(1)]);
    expect(read('rollout.jsonl', 'same-file-version', [line(2)])).toEqual([pr(2)]);
  });

  test('keeps unchanged attribution but reflects append, equal-size rewrite, replacement and truncation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-pr-cache-'));
    const path = join(dir, 'rollout.jsonl');
    const read = createCodexPrReader();
    const snapshot = async (path: string, bytes = 4 * 1024 * 1024) => {
      const { lines, version } = await readTailLines(path, bytes);
      return read(path, version, lines);
    };
    try {
      writeFileSync(path, line(1));
      expect(await snapshot(path)).toEqual([pr(1)]);
      const visible = await snapshot(path);
      visible.push(pr(99));
      expect(await snapshot(path)).toEqual([pr(1)]);
      appendFileSync(path, line(2));
      expect(await snapshot(path)).toEqual([pr(1), pr(2)]);
      writeFileSync(path, line(3) + line(2));
      expect(await snapshot(path)).toEqual([pr(3), pr(2)]);
      const replacement = join(dir, 'replacement.jsonl');
      writeFileSync(replacement, line(4) + line(2));
      renameSync(replacement, path);
      expect(await snapshot(path)).toEqual([pr(4), pr(2)]);
      expect(await snapshot(path, Buffer.byteLength(line(2)))).toEqual([]);
      writeFileSync(path, line(5));
      expect(await snapshot(path)).toEqual([pr(5)]);
      const other = join(dir, 'other.jsonl');
      writeFileSync(other, line(6));
      expect(await snapshot(other)).toEqual([pr(6)]);
      expect(await snapshot(path)).toEqual([pr(5)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
