import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideNeoTool } from '../../../../src/lib/neo/look-up-guard.ts';

describe('Neo reads only published worker handoffs', () => {
  let home: string;
  let dataDir: string;
  let published: string;
  let report: string;
  const digest = 'a'.repeat(64);
  const scope = () => ({ home, dataDir, cwd: home });
  const read = (file_path: string) => decideNeoTool('Read', { file_path }, scope()).kind;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'neo-handoff-guard-')));
    dataDir = join(home, '.hyperneo');
    published = join(dataDir, 'handoffs', 'worker-1', 'published', digest);
    mkdirSync(published, { recursive: true, mode: 0o700 });
    report = join(published, 'report.md');
    writeFileSync(report, 'Synthetic worker report');
    chmodSync(report, 0o444);
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test('admits the published report through the same Read decision used by the SDK hook', () => {
    expect(read(report)).toBe('allow');
  });

  test('keeps drafts, worker workspaces, sibling data and the outbox parent private', () => {
    for (const relative of [
      'daemon.db',
      'handoffs',
      'handoffs/worker-1',
      'handoffs/worker-1/drafts/report.md',
      'handoffs/worker-2/drafts/report.md',
      'workspaces/worker-1/report.md',
      'handoffs/worker-1/published/../../../daemon.db',
    ])
      expect(read(join(dataDir, relative))).toBe('deny');
  });

  test('never turns the readable report into a Neo write root', () => {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      expect(decideNeoTool(tool, { file_path: report, notebook_path: report }, scope()).kind).toBe(
        'deny'
      );
    }
  });

  test('preserves secret-name checks inside the published subtree', () => {
    for (const name of ['.env', 'credentials.json', 'private.key']) {
      const path = join(published, name);
      writeFileSync(path, 'synthetic only');
      chmodSync(path, 0o444);
      expect(read(path)).toBe('deny');
    }
  });

  test('rejects symlinks to private files, including a replaced published directory', () => {
    const privateDir = join(dataDir, 'private');
    mkdirSync(privateDir);
    const privateFile = join(privateDir, 'report.md');
    writeFileSync(privateFile, 'synthetic private sibling');
    symlinkSync(privateFile, join(published, 'linked.md'));
    expect(read(join(published, 'linked.md'))).toBe('deny');
    rmSync(published, { recursive: true });
    symlinkSync(privateDir, published);
    expect(read(report)).toBe('deny');
  });

  test('rejects a hard link to private sibling data', () => {
    const privateFile = join(dataDir, 'private.md');
    writeFileSync(privateFile, 'synthetic private sibling');
    linkSync(privateFile, join(published, 'linked.md'));
    expect(read(join(published, 'linked.md'))).toBe('deny');
  });

  test('rejects a draft-directory symlink aimed at a published artifact', () => {
    const draft = join(dataDir, 'handoffs', 'worker-1', 'drafts');
    mkdirSync(draft);
    symlinkSync(report, join(draft, 'report.md'));
    expect(read(join(draft, 'report.md'))).toBe('deny');
  });
});
