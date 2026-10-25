import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodingMergeFactsRepository } from '../../../../src/lib/neo/packs/coding/merge-facts.ts';
import { createCodingMergeReader } from '../../../../src/lib/neo/packs/coding/merge-reader.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('default deploy reader ledger contract', () => {
  test('covered merges survive refused GitHub reads and reopen; missing reads coalesce and failures stay unknown', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-ledger-rpc-')));
    mkdirSync(join(run, 'home'));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/github-ledger-deploy-merge.ts',
              import.meta.url
            )
          ),
          run,
        ],
        {
          env: {
            HOME: join(run, 'home'),
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            HYPERNEO_DATA_DIR: join(run, 'data'),
            LOG_LEVEL: 'error',
          },
          timeout: 30_000,
          stdio: 'pipe',
        }
      );
      const proof = JSON.parse(readFileSync(join(run, 'evidence/deploy-merge.json'), 'utf8'));
      expect(proof.verified).toBe(true);
      expect(proof.mergeCounts).toEqual({
        known: 0,
        missing: 1,
        repeat: 0,
        reopen: 0,
        failed: 1,
        partial: 1,
        recovered: 1,
        closed: 1,
      });
      expect(proof.known.prs[0].mergeCommit).toBe('c'.repeat(40));
      expect(proof.concurrent).toHaveLength(5);
      expect(proof.legacyMissingLookups).toBe(5);
      expect(proof.failed.reason).toBe('failed');
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('merge reader identity and revision contract', () => {
  test('known GitHub and Enterprise merge facts remain distinct', async () => {
    const db = new Database(':memory:');
    createCodingPackTables(db);
    try {
      const facts = new CodingMergeFactsRepository(db);
      for (const [repo, commit] of [
        ['owner/repo', 'a'],
        ['ghe.example/owner/repo', 'b'],
      ])
        (
          await facts.observeCurrent(
            repo,
            7,
            { value: { state: 'MERGED', mergeCommit: commit.repeat(40) }, source: 'synthetic' },
            100,
            0
          )
        ).accepted;
      const read = createCodingMergeReader(
        () => db,
        (() => {
          throw new Error('Covered read must not spawn');
        }) as SpawnFn,
        () => 100
      );
      expect(await read('https://github.com/owner/repo/pull/7')).toBe('a'.repeat(40));
      expect(await read('https://ghe.example/owner/repo/pull/7')).toBe('b'.repeat(40));
    } finally {
      db.close();
    }
  });

  test('a late merged response cannot replace a newer closed observation', async () => {
    const db = new Database(':memory:');
    createCodingPackTables(db);
    let started!: () => void, finish!: (code: number) => void;
    const held = new Promise<void>((resolve) => {
      started = resolve;
    });
    const exit = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const spawn: SpawnFn = () => {
      started();
      return {
        stdout: new Response(
          JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) } })
        ).body,
        stderr: new Response('').body,
        exited: exit,
        exitCode: null,
        kill: () => {},
      };
    };
    try {
      const result = createCodingMergeReader(
        () => db,
        spawn,
        () => 100
      )('https://github.com/owner/repo/pull/7');
      await held;
      const facts = new CodingMergeFactsRepository(db);
      expect(
        (
          await facts.observeCurrent(
            'owner/repo',
            7,
            { value: { state: 'CLOSED', mergeCommit: null }, source: 'newer' },
            100,
            0
          )
        ).accepted
      ).toBe(true);
      finish(0);
      expect(await result).toBe(null);
      expect(facts.read('owner/repo', 7, 100, 120_000).merge).toMatchObject({
        status: 'known',
        source: 'newer',
        value: { state: 'CLOSED', mergeCommit: null },
      });
    } finally {
      finish(0);
      db.close();
    }
  });
});
