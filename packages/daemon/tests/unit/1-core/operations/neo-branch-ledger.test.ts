import { createNeoPackPreferencesTable } from '../../../../src/storage/schema/m426-neo-pack-preferences.ts';
import { fileURLToPath } from 'node:url';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { describe, expect, test, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodingBranchPrReader } from '../../../../src/lib/neo/packs/coding/branch-reader.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/ledger/pull/7';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'branch-ledger-'));
  const checkout = (name: string) => {
    const cwd = join(root, name);
    mkdirSync(cwd);
    execFileSync('git', ['init', '-b', 'feature'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/Synthetic/Ledger.git'], {
      cwd,
      stdio: 'pipe',
    });
    return { cwd, branch: 'feature' };
  };
  const db = new Database(join(root, 'facts.db'));
  createNeoPackPreferencesTable(db);
  createCodingPackTables(db);
  let calls = 0;
  const requests: string[][] = [];
  const spawn: SpawnFn = (args) => {
    calls++;
    requests.push(args);
    const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : 'synthetic/ledger';
    return {
      stdout: new Response(
        JSON.stringify([
          {
            url:
              repo.split('/').length === 3
                ? `https://${repo}/pull/7`
                : url.replace('synthetic/ledger', repo),
          },
        ])
      ).body,
      stderr: new Response('').body,
      exited: new Promise<number>((done) => setTimeout(() => done(0), 20)),
      exitCode: null,
      kill: () => {},
    };
  };
  const reader = (db: Database) => createCodingBranchPrReader(() => db, spawn);
  return {
    root,
    db,
    checkout,
    reader,
    calls: () => calls,
    requests: () => requests,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('ledger branch reader', () => {
  test('refresh does not read branch admission through the main repository', async () => {
    const f = fixture();
    const facts = new CodingPrLedgerRepository(f.db).branchFacts;
    const main = spyOn(facts, 'read').mockImplementation(() => {
      throw new Error('branch refresh read on main repository');
    });
    try {
      const result = await facts.refresh('synthetic/ledger', 'feature', () => response([{ url }]));
      expect(result.membership).toMatchObject({ status: 'known', urls: [url] });
    } finally {
      main.mockRestore();
      f.cleanup();
    }
  });

  test('simultaneous requests for one branch share one upstream read', async () => {
    const f = fixture();
    try {
      const query = f.checkout('one'),
        read = f.reader(f.db);
      expect(await Promise.all(Array.from({ length: 5 }, () => read(query)))).toEqual(
        Array.from({ length: 5 }, () => [url])
      );
      expect(f.calls()).toBe(1);
    } finally {
      f.cleanup();
    }
  });
  test('fork checkouts keep GitHub CLI upstream and explicit default selection', async () => {
    const f = fixture();
    try {
      const query = f.checkout('fork'),
        read = f.reader(f.db);
      execFileSync(
        'git',
        ['remote', 'add', 'upstream', 'https://github.com/synthetic/parent.git'],
        { cwd: query.cwd, stdio: 'pipe' }
      );
      expect(await read(query)).toEqual([url.replace('synthetic/ledger', 'synthetic/parent')]);
      execFileSync('git', ['config', 'remote.origin.gh-resolved', 'base'], {
        cwd: query.cwd,
        stdio: 'pipe',
      });
      expect(await read(query)).toEqual([url]);
      execFileSync('git', ['config', 'remote.origin.gh-resolved', 'synthetic/selected'], {
        cwd: query.cwd,
        stdio: 'pipe',
      });
      expect(await read(query)).toEqual([url.replace('synthetic/ledger', 'synthetic/selected')]);
      expect(f.requests().map((args) => args[args.indexOf('--repo') + 1])).toEqual([
        'synthetic/parent',
        'synthetic/ledger',
        'synthetic/selected',
      ]);
    } finally {
      f.cleanup();
    }
  });
  test('Enterprise hosts and explicit host defaults stay separate from github.com coverage', async () => {
    const f = fixture();
    try {
      const query = f.checkout('enterprise'),
        read = f.reader(f.db);
      expect(await read(query)).toEqual([url]);
      for (const remote of [
        'https://ghe.example/synthetic/ledger.git',
        'git@ghe.example:synthetic/ledger.git',
        'ssh://git@ghe.example/synthetic/ledger.git',
      ]) {
        execFileSync('git', ['remote', 'set-url', 'origin', remote], {
          cwd: query.cwd,
          stdio: 'pipe',
        });
        expect(await read(query)).toEqual(['https://ghe.example/synthetic/ledger/pull/7']);
      }
      execFileSync(
        'git',
        ['config', 'remote.origin.gh-resolved', 'other.example/synthetic/selected'],
        { cwd: query.cwd, stdio: 'pipe' }
      );
      expect(await read(query)).toEqual(['https://other.example/synthetic/selected/pull/7']);
      expect(f.requests().map((args) => args[args.indexOf('--repo') + 1])).toEqual([
        'synthetic/ledger',
        'ghe.example/synthetic/ledger',
        'other.example/synthetic/selected',
      ]);
      expect(
        new CodingPrLedgerRepository(f.db).branchFacts.read('synthetic/ledger', 'feature')
          .membership
      ).toMatchObject({ status: 'known', urls: [url] });
    } finally {
      f.cleanup();
    }
  });
  test('port-bearing Enterprise remotes reuse the same host coverage', async () => {
    const f = fixture();
    try {
      const query = f.checkout('port'),
        read = f.reader(f.db);
      for (const remote of [
        'ssh://git@ghe.example:22/synthetic/ledger.git',
        'https://ghe.example:8443/synthetic/ledger.git',
      ]) {
        execFileSync('git', ['remote', 'set-url', 'origin', remote], {
          cwd: query.cwd,
          stdio: 'pipe',
        });
        expect(await read(query)).toEqual(['https://ghe.example/synthetic/ledger/pull/7']);
      }
      expect(f.calls()).toBe(1);
    } finally {
      f.cleanup();
    }
  });
  test('transient SQLite contention preserves the shared branch read for every caller', async () => {
    const f = fixture(),
      query = f.checkout('busy');
    const transaction = f.db.transaction.bind(f.db);
    let failures = 2;
    const fault = spyOn(f.db, 'transaction').mockImplementation(((fn, mode) => {
      const commit = transaction(fn, mode);
      return (...args) => {
        if (failures-- > 0)
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        return commit(...args);
      };
    }) as typeof f.db.transaction);
    try {
      const read = f.reader(f.db);
      expect(await Promise.all([read(query), read(query)])).toEqual([[url], [url]]);
      expect(
        new CodingPrLedgerRepository(f.db).branchFacts.read('synthetic/ledger', 'feature')
          .membership
      ).toMatchObject({ status: 'known', urls: [url] });
      expect(f.calls()).toBe(1);
    } finally {
      fault.mockRestore();
      f.cleanup();
    }
  });
  test('checkout HEAD discovery and invalid locations keep their existing behavior', async () => {
    const f = fixture();
    try {
      const query = f.checkout('head'),
        read = f.reader(f.db);
      expect(await read({ cwd: query.cwd })).toEqual([url]);
      execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/second'], {
        cwd: query.cwd,
        stdio: 'pipe',
      });
      expect(await read({ cwd: query.cwd })).toEqual([url]);
      expect(f.calls()).toBe(2);
      for (const cwd of ['relative', join(f.root, 'absent'), '/invalid\0path'])
        expect(await read({ cwd })).toEqual([]);
      expect(await read({ cwd: query.cwd, branch: '' })).toEqual([]);
      expect(f.calls()).toBe(2);
    } finally {
      f.cleanup();
    }
  });
  test('a second checkout and a reopened collector use persisted repository coverage', async () => {
    const f = fixture();
    try {
      const read = f.reader(f.db);
      expect(await read(f.checkout('one'))).toEqual([url]);
      expect(await read(f.checkout('two'))).toEqual([url]);
      expect(f.calls()).toBe(1);
      const reopened = new Database(join(f.root, 'facts.db'));
      try {
        expect(await f.reader(reopened)(f.checkout('three'))).toEqual([url]);
        expect(f.calls()).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      f.cleanup();
    }
  });
});

function response(data: unknown, code = 0, error = '', raw = false): ReturnType<SpawnFn> {
  return {
    stdout: new Response(raw ? String(data) : JSON.stringify(data)).body,
    stderr: new Response(error).body,
    exited: Promise.resolve(code),
    exitCode: code,
    kill: () => {},
  };
}

describe('branch coverage', () => {
  test('known empty, stale, failed and recovered reads stay distinct without losing prior data', async () => {
    const f = fixture();
    try {
      const facts = new CodingPrLedgerRepository(f.db).branchFacts;
      let now = 100,
        data: unknown = [{ url }],
        calls = 0;
      const spawn: SpawnFn = () => {
        calls++;
        return response(data);
      };
      expect(facts.read('synthetic/ledger', 'feature', now).membership).toMatchObject({
        status: 'unknown',
        reason: 'missing',
      });
      const first = await facts.refresh('Synthetic/Ledger', 'feature', spawn, () => now);
      expect(first).toMatchObject({
        repo: 'synthetic/ledger',
        coverage: { state: 'all', limit: 5 },
        membership: { status: 'known', urls: [url] },
      });
      now += 120000;
      expect(facts.read('synthetic/ledger', 'feature', now).membership).toMatchObject({
        status: 'unknown',
        reason: 'stale',
      });
      data = { unexpected: true };
      const failed = await facts.refresh('synthetic/ledger', 'feature', spawn, () => now);
      expect(failed.membership).toMatchObject({
        status: 'unknown',
        reason: 'partial',
        observedAt: 100,
      });
      expect(f.db.prepare('SELECT urls_json FROM pack_coding_branch_facts').get()).toEqual({
        urls_json: JSON.stringify([url]),
      });
      data = [{ url }];
      now++;
      const recovered = await facts.refresh('synthetic/ledger', 'feature', spawn, () => now);
      expect(recovered.factRevision).toBe(first.factRevision);
      expect(recovered.observationRevision).toBeGreaterThan(first.observationRevision);
      now += 120000;
      data = [];
      const empty = await facts.refresh('synthetic/ledger', 'feature', spawn, () => now);
      expect(empty.membership).toMatchObject({ status: 'known', urls: [] });
      expect(empty.factRevision).toBeGreaterThan(first.factRevision);
      expect(calls).toBe(4);
    } finally {
      f.cleanup();
    }
  });
  test('over-limit responses refuse instead of claiming a complete empty branch', async () => {
    const f = fixture();
    try {
      const facts = new CodingPrLedgerRepository(f.db).branchFacts;
      const read = await facts.refresh('synthetic/ledger', 'feature', () =>
        response(Array.from({ length: 6 }, () => ({ url })))
      );
      expect(read.membership).toMatchObject({ status: 'unknown', reason: 'partial' });
    } finally {
      f.cleanup();
    }
  });
  test('rate-limited refreshes respect retry-after and do not certify old membership', async () => {
    const f = fixture();
    try {
      const facts = new CodingPrLedgerRepository(f.db).branchFacts;
      let now = 100,
        calls = 0;
      const limited: SpawnFn = () => {
        calls++;
        return response('HTTP/2 403\nretry-after: 5\n\n{}', 1, 'secondary rate limit', true);
      };
      expect(
        (await facts.refresh('synthetic/ledger', 'feature', limited, () => now)).membership
      ).toMatchObject({ status: 'unknown', reason: 'rate_limited' });
      now++;
      await facts.refresh('synthetic/ledger', 'feature', limited, () => now);
      expect(calls).toBe(1);
      now += 5000;
      const recovered = await facts.refresh(
        'synthetic/ledger',
        'feature',
        () => {
          calls++;
          return response([{ url }]);
        },
        () => now
      );
      expect(recovered.membership).toMatchObject({ status: 'known', urls: [url] });
      expect(calls).toBe(2);
    } finally {
      f.cleanup();
    }
  });
  test('aliases share collector work and a late response cannot replace newer stored facts', async () => {
    const f = fixture();
    let other: Database | undefined;
    try {
      f.db
        .prepare('INSERT INTO pack_coding_repo_aliases(alias,canonical) VALUES(?,?)')
        .run('old/repo', 'synthetic/ledger');
      const facts = new CodingPrLedgerRepository(f.db).branchFacts;
      let finish!: (code: number) => void,
        calls = 0;
      const slow: SpawnFn = () => {
        calls++;
        return {
          ...response([{ url }]),
          exited: new Promise<number>((done) => {
            finish = done;
          }),
        };
      };
      const held = facts.refresh('old/repo', 'feature', slow, () => 100);
      const same = new CodingPrLedgerRepository(f.db).branchFacts.refresh(
        'Synthetic/Ledger',
        'feature',
        slow,
        () => 100
      );
      expect(calls).toBe(1);
      other = new Database(join(f.root, 'facts.db'));
      const newer = new CodingPrLedgerRepository(other).branchFacts;
      const changed = url.replace('/7', '/8');
      const fast = await newer.refresh(
        'synthetic/ledger',
        'feature',
        () => response([{ url: changed }]),
        () => 200
      );
      finish(0);
      expect((await held).membership).toEqual(fast.membership);
      expect((await same).membership).toEqual(fast.membership);
      expect(newer.read('synthetic/ledger', 'feature', 200).observationRevision).toBe(1);
    } finally {
      other?.close();
      f.cleanup();
    }
  });
});

test('the actual daemon watcher shares branch coverage and reuses it after reopen', () => {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'branch-ledger-rpc-')));
  mkdirSync(join(run, 'home'));
  try {
    execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL(
            '../../../../../../.claude/skills/verify/github-ledger-branch.ts',
            import.meta.url
          )
        ),
        run,
      ],
      {
        cwd: run,
        env: {
          HOME: join(run, 'home'),
          PATH: process.env.PATH!,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(run, 'data'),
          LOG_LEVEL: 'error',
        },
        timeout: 30000,
        stdio: 'pipe',
      }
    );
    const observed = JSON.parse(readFileSync(join(run, 'evidence/branch-ledger.json'), 'utf8'));
    expect(observed.verified).toBe(true);
    expect(observed.counts).toEqual({ watch: 1, legacy: 2, reopen: 0 });
    expect(observed.fact.membership).toMatchObject({ status: 'known', urls: [url] });
    expect(observed.snapshot.ok).toBe(true);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('an unlisted checkout makes no GitHub request until the human watches its repository', async () => {
  const f = fixture();
  try {
    f.db
      .prepare(
        "INSERT INTO neo_pack_preferences VALUES ('coding', 'global', '', 'watchedRepos', '[]', 'human', 1)"
      )
      .run();
    const checkout = f.checkout('unlisted');
    expect(await f.reader(f.db)(checkout)).toEqual([]);
    expect(f.calls()).toBe(0);
    f.db.prepare('UPDATE neo_pack_preferences SET value_json = \'["synthetic/ledger"]\'').run();
    expect(await f.reader(f.db)(checkout)).toEqual([url]);
    expect(f.calls()).toBe(1);
  } finally {
    f.cleanup();
  }
});
