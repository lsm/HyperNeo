import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { withCodingWorkerStartBrief } from '../../../../src/lib/neo/packs/coding/worker-worktree-brief.ts';

describe('coding worker handoff', () => {
  test('briefs the inherited checkout and its outstanding work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-'));
    const previousPath = process.env.PATH;
    try {
      const git = (args: string[], input?: string) =>
        execFileSync('git', args, { cwd: root, input, encoding: 'utf8' }).trim();
      git(['init', '-q']);
      const tree = git(['hash-object', '-t', 'tree', '-w', '--stdin'], '');
      const commit = (parent?: string) =>
        git(
          ['hash-object', '-t', 'commit', '-w', '--stdin'],
          `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\n\nfixture\n`
        );
      const base = commit();
      const head = commit(base);
      git(['update-ref', 'refs/heads/handoff', head]);
      git(['symbolic-ref', 'HEAD', 'refs/heads/handoff']);
      git(['update-ref', 'refs/remotes/origin/handoff', base]);
      git(['config', 'remote.origin.url', 'https://github.com/example/repo.git']);
      git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
      git(['config', 'branch.handoff.remote', 'origin']);
      git(['config', 'branch.handoff.merge', 'refs/heads/handoff']);
      writeFileSync(join(root, 'unfinished.txt'), 'unfinished');
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'gh'),
        '#!/bin/sh\nprintf \'[{"url":"https://github.com/example/repo/pull/12"}]\'\n',
        { mode: 0o755 }
      );
      process.env.PATH = `${bin}:${previousPath}`;

      const brief = await withCodingWorkerStartBrief('Continue.', {
        replacedWorker: { folder: root },
      });
      expect(brief).toContain('handoff');
      expect(brief).toContain('unfinished.txt');
      expect(brief).toContain(head.slice(0, 7));
      expect(brief).toContain('https://github.com/example/repo/pull/12');
      expect(brief).toContain(root);

      git(['config', '--unset', 'branch.handoff.remote']);
      git(['config', '--unset', 'branch.handoff.merge']);
      const neverPushed = await withCodingWorkerStartBrief('Continue.', {
        replacedWorker: { folder: root },
      });
      expect(neverPushed).toContain(head.slice(0, 7));
      expect(neverPushed).not.toContain('Upstream unavailable');
    } finally {
      process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a large inherited checkout still fits a worker start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-wide-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      for (let index = 0; index < 700; index++)
        writeFileSync(join(root, `${String(index).padStart(4, '0')}-${'x'.repeat(155)}`), 'x');
      const instruction = 'Continue this task. '.repeat(1000);
      const brief = await withCodingWorkerStartBrief(instruction, {
        replacedWorker: { folder: root },
      });
      expect(brief.length).toBeLessThanOrEqual(100_000);
      expect(brief).toContain('truncated');
      expect(brief).toContain(instruction);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a start without a replaced worker keeps its original brief', async () => {
    const plain = await withCodingWorkerStartBrief('Continue.');
    const targeted = await withCodingWorkerStartBrief('Continue.', { target: 'dev' });
    expect(plain).toContain('Continue.');
    expect(plain).not.toContain('inherited checkout');
    expect(targeted).toContain('"target":"dev"');
    expect(targeted).not.toContain('inherited checkout');
  });
});
