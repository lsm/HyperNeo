import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
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
