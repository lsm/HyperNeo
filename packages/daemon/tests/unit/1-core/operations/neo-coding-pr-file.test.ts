import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { createCodingPrFileOperation } from '../../../../src/lib/neo/packs/coding/pr-file-operation.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';

const sha = 'a'.repeat(40);
const input = {
  context: { kind: 'ask' as const, id: 'ask' },
  pr: 'example/project#42',
  path: 'report.md',
  headSha: sha,
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const neo = { source: 'mcp' as const, role: 'neo' as const, sessionId: 'neo' };
function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  new NeoAskTodoRepository(db).openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Review',
    request: 'Review',
    createdAt: 1,
  });
  let reads = 0;
  const op = createCodingPrFileOperation(
    () => db,
    undefined,
    undefined,
    async () => {
      reads++;
      return { headSha: sha, files: [{ path: 'report.md' }] } as never;
    }
  );
  return { db, op, reads: () => reads };
}
describe('coding PR complete-file attachment', () => {
  test('only the context owner Neo can look up the PR', async () => {
    const f = setup();
    try {
      for (const caller of [
        { ...neo, sessionId: 'other' },
        { source: 'rpc' as const, principal: 'local' as const },
        { ...neo, role: 'direct_task_worker' as const },
      ]) {
        expect(await f.op.execute(input, caller)).toEqual({
          accepted: false,
          reason: 'unavailable',
        });
      }
      expect(f.reads()).toBe(0);
    } finally {
      f.db.close();
    }
  });
  test('refuses a stale head or unlisted path before fetching bytes', async () => {
    const f = setup();
    try {
      for (const change of [{ headSha: 'b'.repeat(40) }, { path: 'not-in-pr.md' }]) {
        expect(await f.op.execute({ ...input, ...change }, neo)).toEqual({
          accepted: false,
          reason: 'source_changed',
        });
      }
      expect(f.reads()).toBe(2);
    } finally {
      f.db.close();
    }
  });
  test('rejects arbitrary URLs and injected file contents', () => {
    const f = setup();
    try {
      expect(
        f.op.inputSchema.safeParse({ ...input, pr: 'https://example.com/report.md' }).success
      ).toBe(false);
      expect(f.op.inputSchema.safeParse({ ...input, content: 'diff --git' }).success).toBe(false);
      expect(
        f.op.inputSchema.safeParse({ ...input, pr: 'https://github.com/example/project/pull/42' })
          .success
      ).toBe(true);
    } finally {
      f.db.close();
    }
  });
});

test('attaches the full Markdown document through an isolated daemon agent door', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coding-pr-file-')));
  mkdirSync(join(root, 'home'));
  try {
    const output = execFileSync(
      'bun',
      [
        fileURLToPath(
          new URL('../../../../../../.claude/skills/verify/coding-pr-file.ts', import.meta.url)
        ),
        '0',
        root,
      ],
      {
        env: {
          HOME: join(root, 'home'),
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: join(root, 'data'),
          LOG_LEVEL: 'error',
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
        encoding: 'utf8',
        timeout: 30000,
      }
    );
    expect(output).toContain('PASS: owner Neo MCP');
    const proof = JSON.parse(readFileSync(join(root, 'evidence/observed.json'), 'utf8'));
    expect(proof.status).toBe('pass');
    expect(proof.fullContent).toContain('Unchanged appendix.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
