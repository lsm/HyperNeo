import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function hookFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hyperneo-hook-test-'));
  fixtures.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  writeFileSync(
    join(repo, 'scripts', 'lib', 'inert-docs.sh'),
    readFileSync(resolve('scripts/lib/inert-docs.sh'))
  );
  const git = (...args: string[]) =>
    spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repo, encoding: 'utf8' }
    );
  const commit = () => git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'c');
  git('init', '-q');
  git('add', '-A');
  commit();
  git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
  const stage = (...paths: string[]) => {
    for (const path of paths) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), 'x\n');
    }
    git('add', '--', ...paths);
  };
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub(
    'bun',
    `echo "$2" >> "$HOOK_TEST_ROOT/bun-calls"
  if [ "$2" = typecheck ]; then
    sleep 0.1
    if [ "\${HOOK_TEST_FAIL:-0}" = 1 ]; then
      echo 'packages/daemon/src/example.ts(1,1): error TS2322: mismatch'
      exit 1
    fi
  fi`
  );
  stub(
    'tee',
    `echo "$1" >> "$HOOK_TEST_ROOT/paths"
    case "$1" in
      "$HOOK_TEST_ROOT"/*) exec /usr/bin/tee "$@" ;;
      *) exec /usr/bin/tee /dev/null ;;
    esac`
  );
  stub(
    'rm',
    `case "$*" in
    *"$HOOK_TEST_ROOT"*) exec /bin/rm "$@" ;;
    *) exit 0 ;;
  esac`
  );
  const pathFilter = () => {
    const workflow = Bun.YAML.parse(
      readFileSync(resolve('.github/workflows/main.yml'), 'utf8')
    ) as {
      jobs: { changes: { steps: { id?: string; run?: string }[] } };
    };
    const step = workflow.jobs.changes.steps.find((s) => s.id === 'filter');
    const script = (step?.run ?? '').replace(/^\s*git fetch .*$/m, '');
    commit();
    const output = join(root, 'github-output');
    writeFileSync(output, '');
    spawnSync('bash', ['-c', script], {
      cwd: repo,
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return readFileSync(output, 'utf8').match(/^code=(\w+)$/m)?.[1];
  };
  return {
    root,
    stage,
    commit,
    git,
    pathFilter,
    bunCalls: () =>
      existsSync(join(root, 'bun-calls'))
        ? readFileSync(join(root, 'bun-calls'), 'utf8').trim().split('\n')
        : [],
    run: async (fail = false) => {
      const child = Bun.spawn(['bash', resolve('scripts/git-hooks/pre-commit')], {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TMPDIR: root,
          HOOK_TEST_ROOT: root,
          HOOK_TEST_FAIL: fail ? '1' : '0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, output, error };
    },
  };
}

test('concurrent hooks use separate temporary files and clean both on success', async () => {
  const fixture = hookFixture();
  const results = await Promise.all([fixture.run(), fixture.run()]);
  expect(results.map((result) => result.code)).toEqual([0, 0]);
  const paths = readFileSync(join(fixture.root, 'paths'), 'utf8').trim().split('\n');
  expect(paths).toHaveLength(2);
  expect(new Set(paths).size).toBe(2);
  for (const path of paths) {
    expect(path.startsWith(fixture.root)).toBe(true);
    expect(existsSync(path)).toBe(false);
  }
});

test('failed typecheck reports its own package errors and cleans its temporary file', async () => {
  const fixture = hookFixture();
  const result = await fixture.run(true);
  expect(result.code).toBe(1);
  expect(result.output).toMatch(/Daemon src:\s+1 error/);
  const path = readFileSync(join(fixture.root, 'paths'), 'utf8').trim();
  expect(path.startsWith(fixture.root)).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test('a commit staging only inert docs skips every code check', async () => {
  const fixture = hookFixture();
  fixture.stage('docs/design/new-plan.md', 'README.md');
  const result = await fixture.run();
  expect(result.code).toBe(0);
  expect(fixture.bunCalls()).toEqual([]);
});

test('a nested markdown file outside docs still runs the code checks', async () => {
  const fixture = hookFixture();
  fixture.stage('docs/design/new-plan.md', 'packages/skills/example/SKILL.md');
  const result = await fixture.run();
  expect(result.code).toBe(0);
  expect(fixture.bunCalls()).toEqual(['lint', 'format:check', 'typecheck', 'knip']);
});

test('a commit staging code runs the code checks', async () => {
  const fixture = hookFixture();
  fixture.stage('packages/daemon/src/example.ts');
  const result = await fixture.run();
  expect(result.code).toBe(0);
  expect(fixture.bunCalls()).toEqual(['lint', 'format:check', 'typecheck', 'knip']);
});

const ALL_CHECKS = ['lint', 'format:check', 'typecheck', 'knip'];
const cases: {
  name: string;
  setup: (f: ReturnType<typeof hookFixture>) => void;
  inert: boolean;
}[] = [
  {
    name: 'docs markdown and top-level README',
    setup: (f) => f.stage('docs/a.md', 'README.md'),
    inert: true,
  },
  {
    name: 'non-ASCII docs file name',
    setup: (f) => f.stage('docs/design/设计 plan.md'),
    inert: true,
  },
  {
    name: 'nested agent instruction files',
    setup: (f) => f.stage('packages/daemon/AGENTS.md', 'packages/web/CLAUDE.md'),
    inert: true,
  },
  {
    name: 'nested skill file',
    setup: (f) => f.stage('packages/skills/example/SKILL.md'),
    inert: false,
  },
  { name: 'docs JSON', setup: (f) => f.stage('docs/branding/tokens.json'), inert: false },
  { name: 'TypeScript under docs', setup: (f) => f.stage('docs/example.ts'), inert: false },
  { name: 'shell script under docs', setup: (f) => f.stage('docs/check.sh'), inert: false },
  {
    name: 'code renamed into docs',
    setup: (f) => {
      f.stage('src/a.ts');
      f.commit();
      f.git('update-ref', 'refs/remotes/origin/dev', 'HEAD');
      f.git('mv', 'src/a.ts', 'docs/a.md');
    },
    inert: false,
  },
];

for (const { name, setup, inert } of cases) {
  test(`${name}: hook and CI path filter ${inert ? 'skip' : 'run'} code checks`, async () => {
    const fixture = hookFixture();
    setup(fixture);
    const result = await fixture.run();
    expect(result.code).toBe(0);
    expect(fixture.bunCalls()).toEqual(inert ? [] : ALL_CHECKS);
    expect(fixture.pathFilter()).toBe(inert ? 'false' : 'true');
  });
}
