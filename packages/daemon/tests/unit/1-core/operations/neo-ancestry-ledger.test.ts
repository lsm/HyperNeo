import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodingAncestryFactsRepository } from '../../../../src/lib/neo/packs/coding/ancestry-facts.ts';
import { createCodingAncestryReader } from '../../../../src/lib/neo/packs/coding/ancestry-reader.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

describe('default deploy ancestry ledger contract', () => {
  test('known and cold comparisons read persisted facts without turning failure into negative knowledge', () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), 'ancestry-ledger-')));
    mkdirSync(join(run, 'home'));
    try {
      execFileSync(
        'bun',
        [
          fileURLToPath(
            new URL(
              '../../../../../../.claude/skills/verify/github-ledger-deploy-ancestry.ts',
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
      const proof = JSON.parse(readFileSync(join(run, 'evidence/deploy-ancestry.json'), 'utf8'));
      expect(proof.verified).toBe(true);
      expect(proof.counts).toEqual({
        known: 0,
        baseline: 5,
        cold: 1,
        repeat: 0,
        reopen: 0,
        'known-negative': 0,
        behind: 1,
        failed: 2,
        partial: 1,
        recovered: 2,
      });
      expect(proof.concurrent).toHaveLength(5);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  }, 30_000);

  test('old-schema initialization adds ancestry storage without changing existing merge bytes', () => {
    const db = new Database(':memory:');
    try {
      db.exec(
        'CREATE TABLE pack_coding_merge_facts (repo TEXT NOT NULL, number INTEGER NOT NULL, fact_revision INTEGER NOT NULL, observation_revision INTEGER NOT NULL, value_json TEXT, source TEXT, observed_at INTEGER, attempted_at INTEGER NOT NULL, reason TEXT, PRIMARY KEY(repo,number))'
      );
      const bytes = '{ "state": "MERGED", "mergeCommit": "old" }';
      db.prepare('INSERT INTO pack_coding_merge_facts VALUES(?,?,?,?,?,?,?,?,?)').run(
        'old/repo',
        7,
        3,
        9,
        bytes,
        'old-source',
        10,
        20,
        null
      );
      const before = db.prepare('SELECT * FROM pack_coding_merge_facts').all();
      createCodingPackTables(db);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='pack_coding_ancestry_facts'").get()
      ).toEqual({ name: 'pack_coding_ancestry_facts' });
      expect(db.prepare('SELECT * FROM pack_coding_merge_facts').all()).toEqual(before);
      createCodingPackTables(db);
      expect(db.prepare('SELECT * FROM pack_coding_merge_facts').all()).toEqual(before);
    } finally {
      db.close();
    }
  });
});

describe('ancestry identity and revision contracts', () => {
  const baseOid = 'a'.repeat(40),
    headOid = 'b'.repeat(40);
  test('repo, host and both ordered SHAs define the fact', async () => {
    const db = new Database(':memory:');
    createCodingPackTables(db);
    try {
      const facts = new CodingAncestryFactsRepository(db);
      await facts.observeCurrent(
        { repo: 'owner/repo', baseOid, headOid },
        { status: 'ahead' },
        100,
        0
      );
      await facts.observeCurrent(
        { repo: 'ghe.example/owner/repo', baseOid, headOid },
        { status: 'behind' },
        100,
        0
      );
      const read = createCodingAncestryReader(() => db, (() => {
        throw new Error('Covered ancestry must not spawn');
      }) as SpawnFn);
      expect(await read('https://github.com/owner/repo/pull/7', baseOid, headOid)).toBe(true);
      expect(
        await read('https://www.github.com/owner/repo/pull/7#discussion', baseOid, headOid)
      ).toBe(true);
      expect(await read('https://ghe.example/owner/repo/pull/7', baseOid, headOid)).toBe(false);
      expect(facts.read({ repo: 'other/repo', baseOid, headOid }).ancestry.status).toBe('unknown');
      expect(
        facts.read({ repo: 'owner/repo', baseOid: headOid, headOid: baseOid }).ancestry.status
      ).toBe('unknown');
    } finally {
      db.close();
    }
  });

  test('a late positive response cannot replace a newer negative observation', async () => {
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
        stdout: new Response(JSON.stringify({ status: 'ahead' })).body,
        stderr: new Response('').body,
        exited: exit,
        exitCode: null,
        kill: () => {},
      };
    };
    try {
      const result = createCodingAncestryReader(
        () => db,
        spawn,
        () => 100
      )('https://github.com/owner/repo/pull/7', baseOid, headOid);
      await held;
      const facts = new CodingAncestryFactsRepository(db),
        subject = { repo: 'owner/repo', baseOid, headOid };
      expect(await facts.observeCurrent(subject, { status: 'behind' }, 100, 0)).toMatchObject({
        observationRevision: 1,
        ancestry: { status: 'known', comparison: 'behind', contains: false },
      });
      finish(0);
      expect(await result).toBe(false);
      expect(facts.read(subject)).toMatchObject({
        observationRevision: 1,
        ancestry: { status: 'known', comparison: 'behind', contains: false },
      });
    } finally {
      finish(0);
      db.close();
    }
  });
});
