import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createArtifactReadOperations } from '../../../../src/lib/artifacts/read-operations';
import { createArtifactReferenceResolve } from '../../../../src/lib/artifacts/resolve-operation';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';

const entered = vi.hoisted(() => [] as string[]);
const github = vi.hoisted(() => ({ responses: new Map<string, unknown>(), pr: null as unknown }));

vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

vi.mock('../../../../src/lib/runtime-spawn/index', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/lib/runtime-spawn/index')>();
  return {
    ...real,
    spawnProcess: (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/'));
      const body = endpoint ? github.responses.get(endpoint) : github.pr;
      return {
        stdout: new Response(body ? JSON.stringify(body) : '').body,
        stderr: new Response('').body,
        exited: Promise.resolve(body ? 0 : 1),
        exitCode: body ? 0 : 1,
        kill() {},
      };
    },
  };
});

const noDatabase = () => {
  throw new Error('no database in this test');
};
const agent: OperationCaller = { source: 'mcp', role: 'long_term_agent' };
const human: OperationCaller = { source: 'rpc', principal: 'local' };

const operations = [
  ...createArtifactReadOperations(noDatabase, '/nonexistent'),
  createArtifactReferenceResolve(noDatabase, '/nonexistent', '/nonexistent'),
];

function expectNamedFor(operation: string) {
  expect(entered[0]).toBe(operation);
  for (const helper of entered.slice(1)) {
    expect(helper.startsWith(`${operation}.`)).toBe(true);
  }
}

describe('artifact operations', () => {
  test('covers every artifact operation', () => {
    expect(operations.map((operation) => operation.name).sort()).toEqual([
      'artifact.file.get',
      'artifact.file.html',
      'artifact.file.list',
      'artifact.file.read',
      'artifact.reference.resolve',
    ]);
  });

  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(operation.execute({ artifactId: 'artifact-1' } as never, agent)).catch(
        () => undefined
      );
      expectNamedFor(operation.name);
    }
  );
});

describe('artifact.reference.resolve for the local human', () => {
  const sha = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const bytes = Buffer.from('# Report\n');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const git = 'repos/example/demo/git';
  let main: Database;
  let gateway: DbGateway;
  let root: string;

  const resolve = (reference: string) =>
    createArtifactReferenceResolve(() => main, join(root, 'data'), join(root, 'home')).execute(
      {
        requestId: '11111111-1111-4111-8111-111111111111',
        sourceMessageOrCard: { kind: 'todo', id: 'todo-1' },
        reference,
      },
      human
    );

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-pipeline-names-')));
    mkdirSync(join(root, 'home'));
    main = new Database(':memory:');
    runMigrations(main, () => {});
    createTables(main);
    gateway = new DbGateway(':memory:', main);
    bindGateway(main, gateway);
    const now = Date.now();
    main
      .prepare(
        `INSERT INTO neo_asks (id, session_id, title, request, status, repo, created_at, updated_at)
         VALUES ('ask-1', 'neo:root', 'Report', 'Report', 'open', 'github.com/example/demo', ?, ?)`
      )
      .run(now, now);
    main
      .prepare(
        `INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, state, report, created_at, updated_at)
         VALUES ('todo-1', 'ask-1', 1, 'Report', 'PR merged', ?, 'doing', ?, ?, ?)`
      )
      .run(
        JSON.stringify({
          pack: 'coding',
          kind: 'pr_merged',
          params: { urls: ['https://github.com/example/demo/pull/8'] },
        }),
        `See https://github.com/example/demo/pull/8 and https://github.com/example/demo/blob/${sha}/report.md`,
        now,
        now
      );
    main
      .prepare(
        `INSERT INTO pack_coding_todos (todo_id, repo) VALUES ('todo-1', 'github.com/example/demo')`
      )
      .run();
    github.responses = new Map<string, unknown>([
      [
        `${git}/commits/${sha}`,
        { url: `https://api.github.com/${git}/commits/${sha}`, sha, tree: { sha: tree } },
      ],
      [
        `${git}/trees/${tree}`,
        {
          url: `https://api.github.com/${git}/trees/${tree}`,
          sha: tree,
          truncated: false,
          tree: [
            { path: 'report.md', mode: '100644', type: 'blob', sha: blob, size: bytes.length },
          ],
        },
      ],
      [
        `${git}/blobs/${blob}`,
        {
          url: `https://api.github.com/${git}/blobs/${blob}`,
          sha: blob,
          encoding: 'base64',
          size: bytes.length,
          content: bytes.toString('base64'),
        },
      ],
    ]);
    github.pr = {
      url: 'https://github.com/example/demo/pull/8',
      title: 'Report',
      body: '',
      state: 'OPEN',
      headRefOid: sha,
      reviews: [],
      statusCheckRollup: [],
      changedFiles: 1,
      files: [{ path: 'report.md', additions: 1, deletions: 0 }],
    };
    entered.length = 0;
  });

  afterEach(async () => {
    await gateway.close();
    main.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('reads a bound PR summary in a step of the operation', async () => {
    expect(await resolve('https://github.com/example/demo/pull/8')).toMatchObject({
      accepted: true,
      pr: { headSha: sha },
    });
    expect(entered).toContain('artifact.reference.resolve.plan');
    expect(entered).toContain('artifact.reference.resolve.pr');
    expectNamedFor('artifact.reference.resolve');
  });

  test('reads and admits a bound Git file in steps of the operation', async () => {
    await resolve(`https://github.com/example/demo/blob/${sha}/report.md`);
    for (const step of ['plan', 'capture', 'blob', 'admission'])
      expect(entered).toContain(`artifact.reference.resolve.${step}`);
    expectNamedFor('artifact.reference.resolve');
  });
});
