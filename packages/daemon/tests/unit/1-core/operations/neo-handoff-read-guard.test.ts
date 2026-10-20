import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
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
import { decideNeoTool, neoToolGuard } from '../../../../src/lib/neo/look-up-guard.ts';

describe('Neo reads only published worker handoffs', () => {
  let home: string;
  let dataDir: string;
  let published: string;
  let report: string;
  const digest = createHash('sha256').update('Synthetic worker report').digest('hex');
  const scope = () => ({ home, dataDir, cwd: home });
  const read = (file_path: string) => decideNeoTool('Read', { file_path }, scope()).kind;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'neo-handoff-guard-')));
    dataDir = join(home, '.hyperneo');
    published = join(dataDir, 'handoffs', 'worker-1', 'published', digest);
    mkdirSync(published, { recursive: true, mode: 0o700 });
    report = join(published, 'report.md');
    writeFileSync(report, 'Synthetic worker report');
    writeFileSync(join(dataDir, 'handoffs', '.daemon-id'), 'e8b70c20-0620-4ab4-963f-80f0a1d07d5c');
    chmodSync(report, 0o444);
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test('admits the published report through the same Read decision used by the SDK hook', () => {
    expect(read(report)).toBe('allow');
  });

  test('the actual Read hook verifies a report and refuses tampered bytes', async () => {
    const hook = neoToolGuard({ home, dataDir });
    const call = () =>
      hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: report },
          cwd: home,
          session_id: 'sdk-neo',
          tool_use_id: 'read-1',
          transcript_path: join(home, 'synthetic.jsonl'),
        } as HookInput,
        'read-1',
        { signal: new AbortController().signal }
      );
    expect(await call()).toEqual({});
    chmodSync(report, 0o600);
    writeFileSync(report, 'tampered');
    expect(await call()).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('tampered'),
      },
    });
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

  test('keeps canonical sibling data private when the configured data directory is an alias', () => {
    const alias = join(home, 'data-alias');
    symlinkSync(dataDir, alias);
    const privateFile = join(dataDir, 'private.md');
    writeFileSync(privateFile, 'synthetic private');
    expect(
      decideNeoTool('Read', { file_path: privateFile }, { ...scope(), dataDir: alias }).kind
    ).toBe('deny');
  });
});
