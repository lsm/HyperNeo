import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('worker completion consumes ledger state and refuses unavailable evidence', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'completion-ledger-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/github-ledger-completion-gate.ts',
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
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    const proof = JSON.parse(readFileSync(join(run, 'evidence/completion-gate.json'), 'utf8'));
    expect(proof.verified).toBe(true);
    expect(proof.knownStatus).toBe('done');
    expect(proof.coldReads).toBe(1);
    expect(proof.cold).toHaveLength(5);
    expect(proof.counts).toEqual({
      cold: 1,
      open: 1,
      closed: 1,
      merged: 1,
      failed: 1,
      partial: 1,
      recovered: 1,
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

import { createCodingPrStateReader } from '../../../../src/lib/neo/packs/coding/pr-state-reader.ts';
import { CodingMergeFactsRepository } from '../../../../src/lib/neo/packs/coding/merge-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

function fixture() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  return { db, facts: new CodingMergeFactsRepository(db) };
}

test('a merged canonical alias is covered without another lookup', async () => {
  const { db, facts } = fixture();
  try {
    db.prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)').run(
      'old/repo',
      'synthetic/ledger'
    );
    facts.record(
      'synthetic/ledger',
      7,
      { value: { state: 'MERGED', mergeCommit: 'a'.repeat(40) }, source: 'github-pr-detail' },
      100,
      0
    );
    const read = createCodingPrStateReader(
      () => db,
      () => {
        throw new Error('Unexpected upstream read');
      },
      () => 100
    );
    expect(await read('https://github.com/OLD/REPO/pull/7')).toEqual({ value: 'MERGED' });
  } finally {
    db.close();
  }
});

test('an OPEN observation is refreshed even within the same clock tick', async () => {
  const { db, facts } = fixture();
  try {
    facts.record(
      'synthetic/ledger',
      7,
      { value: { state: 'OPEN', mergeCommit: null }, source: 'github-pr-detail' },
      100,
      0
    );
    const calls: string[][] = [];
    const spawn: SpawnFn = (args) => {
      calls.push(args);
      return {
        exited: Promise.resolve(0),
        stdout: new Response(
          JSON.stringify({ state: 'MERGED', mergeCommit: { oid: 'a'.repeat(40) } })
        ).body!,
        stderr: new Response('').body!,
        kill: () => {},
      };
    };
    expect(
      await createCodingPrStateReader(
        () => db,
        spawn,
        () => 100
      )('https://github.com/synthetic/ledger/pull/7')
    ).toEqual({ value: 'MERGED' });
    expect(calls).toHaveLength(1);
  } finally {
    db.close();
  }
});

test('a failed latest observation cannot reuse an earlier merged fact', async () => {
  const { db, facts } = fixture();
  try {
    facts.record(
      'synthetic/ledger',
      7,
      { value: { state: 'MERGED', mergeCommit: 'a'.repeat(40) }, source: 'github-pr-detail' },
      100,
      0
    );
    facts.record('synthetic/ledger', 7, { reason: 'failed' }, 101, 1);
    const spawn: SpawnFn = () => ({
      exited: Promise.resolve(1),
      stdout: new Response('').body!,
      stderr: new Response('Synthetic unavailable').body!,
      kill: () => {},
    });
    expect(
      await createCodingPrStateReader(
        () => db,
        spawn,
        () => 101
      )('https://github.com/synthetic/ledger/pull/7')
    ).toEqual({ reason: 'GitHub PR state unavailable: failed' });
  } finally {
    db.close();
  }
});

test('unknown hosts and malformed references refuse before reading the DB', async () => {
  const read = createCodingPrStateReader(() => {
    throw new Error('Unexpected DB read');
  });
  expect(await read('https://untrusted.invalid/synthetic/ledger/pull/7')).toEqual({
    reason: 'PR host untrusted.invalid is not allowed for GitHub lookups',
  });
  expect(await read('not-a-pr')).toEqual({ reason: 'Unable to parse GitHub PR URL' });
});

test('fresh MERGED with a nullable commit settles, but each retry observes upstream again', async () => {
  const { db } = fixture();
  try {
    let lookups = 0;
    const spawn: SpawnFn = () => {
      lookups++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(JSON.stringify({ state: 'MERGED', mergeCommit: null })).body!,
        stderr: new Response('').body!,
        kill: () => {},
      };
    };
    const read = createCodingPrStateReader(
      () => db,
      spawn,
      () => 100
    );
    expect(await read('https://github.com/synthetic/ledger/pull/7')).toEqual({ value: 'MERGED' });
    expect(await read('https://github.com/synthetic/ledger/pull/7')).toEqual({ value: 'MERGED' });
    expect(lookups).toBe(2);
  } finally {
    db.close();
  }
});
