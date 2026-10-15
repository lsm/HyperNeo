import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCodeIdentityReader,
  identifyWorkspaces,
  readCodeIdentity,
} from '../../../../src/lib/drivers/code-identity';
import {
  combineFindResults,
  createFindWorkOperation,
  FindWorkInputSchema,
} from '../../../../src/lib/drivers/find-operation';
import { mergePlaceGroups, stampDaemon } from '../../../../src/lib/drivers/places';
import { PlaceGroupSchema, type Place, type PlaceGroup } from '../../../../src/lib/drivers/types';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

function group(place: Place, adapter = 'hyperneo'): PlaceGroup {
  return {
    place,
    adapters: [adapter],
    lastActivityAt: 10,
    openCount: 1,
    archivedCount: 0,
    work: [
      {
        ref: { adapter, id: place.folder ?? place.name },
        title: place.name,
        place,
        status: 'done',
        lastActivityAt: 10,
      },
    ],
  };
}

const git = (folder: string, ...args: string[]) =>
  execFileSync('git', ['-C', folder, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();

describe('git history workspace discovery', () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'code-identity-'));
    repo = join(dir, 'original');
    mkdirSync(repo);
    git(repo, 'init');
    git(repo, 'commit', '--allow-empty', '-m', 'first');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('clones and worktrees share history despite renamed folders and remotes', async () => {
    const clone = join(dir, 'renamed');
    const tree = join(dir, 'worktree');
    git(dir, 'clone', repo, clone);
    git(repo, 'worktree', 'add', '-b', 'topic', tree);
    git(clone, 'remote', 'set-url', 'origin', 'https://example.com/new/repo.git');
    git(repo, 'remote', 'add', 'origin', 'git@example.com:old/repo.git');
    const identity = await readCodeIdentity(repo);
    expect(identity.codeIdentity).toBe(`git:${git(repo, 'rev-parse', 'HEAD')}`);
    expect(identity.remotes).toEqual(['git@example.com:old/repo.git']);
    expect((await readCodeIdentity(clone)).codeIdentity).toBe(identity.codeIdentity);
    expect((await readCodeIdentity(tree)).codeIdentity).toBe(identity.codeIdentity);
    mkdirSync(join(clone, 'nested'));
    expect((await readCodeIdentity(join(clone, 'nested'))).codeIdentity).toBe(
      identity.codeIdentity
    );
    git(clone, 'commit', '--allow-empty', '-m', 'later');
    expect((await readCodeIdentity(clone)).codeIdentity).toBe(identity.codeIdentity);
  });

  test("does not manufacture history for shallow, empty, missing or non-git folders, but keeps a shallow clone's remotes", async () => {
    git(repo, 'commit', '--allow-empty', '-m', 'second');
    const shallow = join(dir, 'shallow');
    git(dir, 'clone', '--depth=1', `file://${repo}`, shallow);
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    git(empty, 'init');
    expect(await readCodeIdentity(shallow)).toEqual({
      remotes: [`file://${repo}`],
      repoName: 'original',
    });
    for (const folder of [empty, dir, join(dir, 'missing')]) {
      expect(await readCodeIdentity(folder)).toEqual({});
    }
  });

  test('names the repository from its remote, or from the main checkout for a worktree without one', async () => {
    const tree = join(dir, 'f793a97e-2b7e-4088-92a1-2506bde88670');
    git(repo, 'worktree', 'add', '-b', 'topic', tree);
    expect((await readCodeIdentity(tree)).repoName).toBe('original');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:lsm/neokai.git');
    expect((await readCodeIdentity(tree)).repoName).toBe('neokai');
  });

  test('the same remote does not make unrelated histories the same project', async () => {
    const other = join(dir, 'other');
    mkdirSync(other);
    git(other, 'init');
    git(other, 'commit', '--allow-empty', '-m', 'unrelated');
    for (const folder of [repo, other])
      git(folder, 'remote', 'add', 'origin', 'https://example.com/same');
    const result = await identifyWorkspaces(
      [repo, other].map((folder) => group({ machine: 'local', folder, name: 'same' }))
    );
    expect(mergePlaceGroups(result, 20)).toHaveLength(2);
  });

  test('work.find carries identity and remote workspace locations through its result schema', async () => {
    const local = group({ machine: 'laptop', folder: repo, name: 'local' });
    const remote = group(
      {
        machine: 'cloud',
        folder: '/cloud/renamed',
        name: 'cloud',
        ...(await readCodeIdentity(repo)),
      },
      'codex-desktop'
    );
    const registry = createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [{ id: 'hyperneo', capabilities: ['find'], find: () => [local] }],
        remote: {
          list: () => [{ daemonId: 'cloud-daemon' }],
          invoke: async () => ({ places: [remote], unreachable: [] }),
        },
      }),
    ]);
    const result = await invokeOperation(registry, 'work.find', {}, { source: 'rpc' });
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('find did not complete');
    const places = (result.value as { places: PlaceGroup[] }).places;
    expect(places).toHaveLength(1);
    expect(PlaceGroupSchema.parse(places[0]).projectId).toBe(
      (await readCodeIdentity(repo)).codeIdentity
    );
    expect(places[0].workspaces).toContainEqual(
      expect.objectContaining({ folder: '/cloud/renamed', daemon: 'cloud-daemon' })
    );
    expect(places[0].work.find((work) => work.ref.adapter === 'codex-desktop')?.ref.daemon).toBe(
      'cloud-daemon'
    );
  });
});

describe('mergePlaceGroups identity links', () => {
  test('a multi-folder tool project joins history groups transitively in any input order', () => {
    const toolProject = { id: 'codex:one', name: 'Product' };
    const places = [
      group({ machine: 'a', folder: '/one', name: 'one', codeIdentity: 'git:one' }),
      group({ machine: 'b', folder: '/two', name: 'two', codeIdentity: 'git:two' }),
      group(
        {
          machine: 'c',
          folder: '/product/one',
          name: 'Product',
          codeIdentity: 'git:one',
          toolProject,
        },
        'codex-desktop'
      ),
      group(
        {
          machine: 'c',
          folder: '/product/two',
          name: 'Product',
          codeIdentity: 'git:two',
          toolProject,
        },
        'codex-desktop'
      ),
    ];
    for (const input of [
      places,
      [...places].reverse(),
      [places[2], places[0], places[3], places[1]],
    ]) {
      const [merged, extra] = mergePlaceGroups(input, 20);
      expect(extra).toBeUndefined();
      expect(merged.projectId).toBe('git:one');
      expect(merged.workspaces).toHaveLength(4);
      expect(merged.work).toHaveLength(4);
      expect(merged.openCount).toBe(4);
    }
  });

  test('remote re-aggregation preserves empty workspaces and stamps their daemon', () => {
    const first = group({ machine: 'host', folder: '/one', name: 'one', codeIdentity: 'git:one' });
    const second = {
      ...group({ machine: 'host', folder: '/two', name: 'two', codeIdentity: 'git:one' }),
      work: [],
    };
    const remote = stampDaemon(mergePlaceGroups([first, second], 10), 'remote');
    expect(mergePlaceGroups(remote, 10)[0].workspaces).toEqual([
      { ...first.place, daemon: 'remote' },
      { ...second.place, daemon: 'remote' },
    ]);
  });

  test('names, folder paths and tool IDs on different machines are not global identities', () => {
    const place = { name: 'same', folder: '/same', toolProject: { id: 'codex:p1', name: 'same' } };
    expect(
      mergePlaceGroups(
        ['a', 'b'].map((machine) => group({ ...place, machine })),
        10
      )
    ).toHaveLength(2);
    expect(
      mergePlaceGroups(
        ['a', 'b'].map((daemon) => group({ ...place, machine: 'host', daemon })),
        10
      )
    ).toHaveLength(2);
  });
});

describe('identifyWorkspaces', () => {
  test('probes each physical folder once and keeps empty workspace metadata', async () => {
    const place = { machine: 'local', folder: '/one', name: 'one' };
    const called: string[] = [];
    const groups = await identifyWorkspaces(
      [{ ...group(place), workspaces: [place, { ...place, folder: '/two' }] }, group(place)],
      async (folder) => {
        called.push(folder);
        return { codeIdentity: 'git:root' };
      }
    );
    expect(called.sort()).toEqual(['/one', '/two']);
    expect(groups[0].workspaces).toContainEqual({
      ...place,
      folder: '/two',
      codeIdentity: 'git:root',
    });
  });
});

describe('workspace discovery safeguards', () => {
  test('shares pending and completed probes per folder, expires misses, and refreshes on demand', async () => {
    let now = 0;
    const calls: string[] = [];
    let identity = {};
    const read = createCodeIdentityReader(
      async (folder) => {
        calls.push(folder);
        return identity;
      },
      () => now
    );
    await Promise.all([read('/repo'), read('/repo')]);
    await read('/repo');
    expect(calls).toEqual(['/repo']);
    identity = { codeIdentity: 'git:new', remotes: ['new-remote'] };
    expect(await read('/repo')).toEqual({});
    now = 60_000;
    expect(await read('/repo')).toEqual(identity);
    identity = { codeIdentity: 'git:replacement', remotes: [] };
    expect(await read('/repo', true)).toEqual(identity);
    await read('/other');
    expect(calls).toEqual(['/repo', '/repo', '/repo', '/other']);
  });

  test('deduplicates physical folders while preserving metadata from every adapter in either order', () => {
    const plain = group({
      machine: 'local',
      folder: '/repo',
      name: 'repo',
      toolProject: undefined,
    });
    const coded = group({ ...plain.place, codeIdentity: 'git:root', remotes: ['origin'] });
    const tool = group({ ...plain.place, toolProject: { id: 'codex:1', name: 'Project' } });
    for (const groups of [
      [plain, coded, tool],
      [tool, coded, plain],
    ]) {
      const merged = mergePlaceGroups(groups, 20);
      expect(merged).toHaveLength(1);
      expect(merged[0].workspaces).toEqual([
        {
          ...plain.place,
          codeIdentity: 'git:root',
          remotes: ['origin'],
          toolProject: tool.place.toolProject,
        },
      ]);
      expect(merged[0].projectId).toBe('git:root');
      expect(mergePlaceGroups(merged, 20)[0].workspaces).toEqual(merged[0].workspaces);
    }
  });

  test('limited browse results retain idle open sessions ahead of newer empty folder shells', () => {
    const open = group({ machine: 'local', folder: '/idle', name: 'idle' });
    open.work[0].status = 'needs_you';
    const shells: PlaceGroup[] = Array.from({ length: 35 }, (_, i) => ({
      ...group({ machine: 'local', folder: `/new/${i}`, name: `${i}` }),
      lastActivityAt: 100 + i,
      openCount: 0,
      work: [],
    }));
    const result = combineFindResults(
      { groups: [...shells, open], unreachable: [] },
      { groups: [], unreachable: [] },
      FindWorkInputSchema.parse({ limit: 30, localOnly: true })
    );
    expect(result.places).toHaveLength(30);
    expect(result.places[0].work[0].ref.id).toBe('/idle');
    expect(result.more).toBe(true);
    shells[0].work = [{ ...open.work[0], score: 10 }];
    expect(mergePlaceGroups([open, shells[0]], 1)[0].place.folder).toBe('/new/0');
  });
});
