import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cli = join(import.meta.dir, 'system-map-impact.ts');
const diffScript = join(import.meta.dir, 'system-map-diff.sh');
const owner = 'packages/example/src/owner.ts';
const removed = 'packages/example/src/deleted.ts';
const peer = 'packages/example/src/peer.ts';
const operation = 'packages/example/src/operation.ts';

function fixture(run: (f: ReturnType<typeof repository>) => void) {
  const root = mkdtempSync(join(tmpdir(), 'system-map-ci-'));
  try {
    run(repository(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function repository(root: string) {
  const spawn = (args: string[]) =>
    Bun.spawnSync(args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
  const git = (...args: string[]) => {
    const result = spawn(['git', ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  function write(path: string, source: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  function commit(message: string) {
    const tree = git('write-tree');
    const parent = git('rev-parse', '--verify', 'HEAD');
    const head = git('commit-tree', tree, '-p', parent, '-m', message);
    git('reset', '--hard', head);
    return head;
  }
  git('init', '-q');
  const empty = git('commit-tree', git('write-tree'), '-m', 'Initial');
  git('reset', '--hard', empty);
  write(owner, "publish('ci.kept'); publish('ci.removed');");
  write(removed, "publish('ci.deleted');");
  write(peer, "subscribe('ci.kept'); subscribe('ci.removed'); subscribe('ci.deleted');");
  write('packages/example/src/importer.ts', "import './owner.ts';");
  write(operation, "defineOperation({ name: 'fixture.read' });");
  git('add', 'packages');
  const base = commit('Base');

  function change(changes: Record<string, string | null>) {
    for (const [path, source] of Object.entries(changes)) {
      if (source === null) git('rm', path);
      else {
        write(path, source);
        git('add', '--', path);
      }
    }
    const head = commit('PR head');
    const merge = git('commit-tree', git('write-tree'), '-p', base, '-p', head, '-m', 'PR merge');
    return { head, merge };
  }

  function check(head: string, changes: string[], body: string, labels: string[] = []) {
    write('paths', `${changes.join('\0')}\0`);
    write(
      'event.json',
      JSON.stringify({
        pull_request: {
          base: { sha: base },
          head: { sha: head },
          body,
          labels: labels.map((name) => ({ name })),
        },
      })
    );
    return spawn([process.execPath, cli, '--check', 'event.json', 'paths']);
  }

  return { spawn, write, git, base, change, check };
}

function block(head: string, base: string, read: string[], entries: unknown[] = [], version = 1) {
  return [
    '```system-map-impact',
    JSON.stringify({ version, head, base, read }),
    ...entries.map((entry) => JSON.stringify(entry)),
    '```',
  ].join('\n');
}

const reason = (path: string) => ({ path, reason: 'Read the listener contract.' });

test('the saved merge diff is NUL-delimited and rejects a different first parent', () => {
  fixture(({ spawn, git, base, change }) => {
    const path = 'docs/a\nname.md';
    const { head, merge } = change({ [path]: 'docs' });
    git('checkout', '--detach', merge);
    const result = spawn(['bash', diffScript, base, merge]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${path}\0`);
    const wrongBase = spawn(['bash', diffScript, head, merge]);
    expect(wrongBase.exitCode).toBe(1);
    expect(wrongBase.stderr.toString()).toContain('first parent');
    expect(wrongBase.stdout.length).toBe(0);
  });
});

test('the CLI accounts for deleted sources and removed peers and ignores importers', () => {
  fixture(({ spawn, base, change, check }) => {
    const { head } = change({ [owner]: "publish('ci.kept');", [removed]: null });
    const printed = spawn([process.execPath, cli, '--print', base]);
    expect(printed.exitCode, printed.stderr.toString()).toBe(0);
    const output = printed.stdout.toString().trim().split('\n');
    expect(output.slice(2, -1).map((line) => JSON.parse(line).path)).toEqual([removed, peer]);

    const entries = [reason(removed), reason(peer)];
    const r = check(head, [owner, removed], block(head, base, ['impact'], entries));
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    expect(r.stdout.toString()).toContain('imported by 1 files outside the plan');
    expect(r.stdout.toString()).toContain('ci.removed');
  });
});

test('attestations cover each change category, including empty path sets', () => {
  const categories: [string[], string[]][] = [
    [['docs/guide.md'], ['map']],
    [['docs/design/plan.md'], ['map', 'impact']],
    [['packages/example/src/new.ts'], ['impact']],
    [
      ['packages/example/src/new.ts', 'packages/desktop/src-tauri/src/lib.rs', 'bun.lock'],
      ['impact'],
    ],
    [
      ['packages/example/src/new.ts', 'docs/guide.md'],
      ['map', 'impact'],
    ],
    [['packages/example/test/unit.test.ts'], ['map', 'impact']],
    [['packages/desktop/src-tauri/src/lib.rs'], ['map', 'impact']],
    [['scripts/tool.ts'], ['map', 'impact']],
    [['bun.lock'], ['map', 'impact']],
  ];
  fixture(({ base, change, check }) => {
    const { head } = change(
      Object.fromEntries(categories.flatMap(([paths]) => paths).map((path) => [path, '']))
    );
    for (const [paths, read] of categories) {
      const success = check(head, paths, block(head, base, [...read, 'where', 'routes']));
      expect(success.exitCode, `${paths.join(', ')}: ${success.stderr}`).toBe(0);
      for (const missing of read) {
        const r = check(
          head,
          paths,
          block(
            head,
            base,
            read.filter((name) => name !== missing)
          )
        );
        expect(r.stderr.toString()).toContain('System map check failed: 1 read');
        expect(r.exitCode).toBe(1);
      }
    }
  });
}, 30_000);

test('invalid bodies fail, and only revert waives the path entries on label revalidation', () => {
  fixture(({ base, change, check }) => {
    const { head } = change({ [owner]: "publish('ci.kept');" });
    const good = block(head, base, ['impact'], [reason(peer)]);
    const claimOnly = block(head, base, ['impact']);
    const bad = [
      '',
      `${good}\n\n${good}`,
      block(base, base, ['impact'], [reason(peer)]),
      block(head, head, ['impact'], [reason(peer)]),
      block(head, base, ['impact'], [reason(peer)], 2),
      block(head, base, ['impact', 'unknown'], [reason(peer)]),
      block(head, base, ['impact'], [reason(peer), reason(peer)]),
      block(head, base, ['impact'], [reason(peer), reason(owner)]),
      block(head, base, ['impact'], [{ path: peer, reason: '  ' }]),
      claimOnly,
    ];
    const success = check(head, [owner], good);
    expect(success.exitCode, success.stderr.toString()).toBe(0);
    for (const body of bad) {
      const r = check(head, [owner], body);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString().trim().split('\n')).toHaveLength(1);
      expect(r.stderr.toString()).toContain('author read entries are claims.');
      expect(r.stdout.toString()).toContain('```system-map-impact');
    }
    expect(check(head, [owner], claimOnly, ['revert']).exitCode).toBe(0);
    expect(check(head, [owner], block(head, base, []), ['revert']).exitCode).toBe(1);
    expect(check(head, [owner], claimOnly, []).exitCode).toBe(1);
    const workflow = readFileSync(
      join(import.meta.dir, '../.github/workflows/system-map.yml'),
      'utf8'
    );
    expect(workflow).toContain(
      'types: [opened, synchronize, reopened, edited, labeled, unlabeled]'
    );
  });
}, 30_000);

test('an analyzer failure reports the command and head instead of validating an empty set', () => {
  fixture(({ base, change, check }) => {
    const manifest = 'packages/example/package.json';
    const { head } = change({ [manifest]: '{' });
    const r = check(head, [manifest], block(head, base, ['map', 'impact']));
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(head);
    expect(r.stderr.toString()).toContain('impact');
    expect(r.stdout.toString()).not.toContain('```system-map-impact');
  });
  fixture(({ base, change, check }) => {
    const { head } = change({ [operation]: null });
    const r = check(head, [operation], block(head, base, ['impact'], [reason(operation)]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(`system-map map failed at head ${head}`);
    expect(r.stdout.toString()).not.toContain('```system-map-impact');
  });
});
