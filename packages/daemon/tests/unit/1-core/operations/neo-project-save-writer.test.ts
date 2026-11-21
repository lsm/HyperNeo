import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNeoProjectSavePipeline } from '../../../../src/lib/neo/project-save.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

const caller = { source: 'rpc' as const, principal: 'local' };
const input = {
  title: 'Project 甲🙂',
  summary: 'Summary',
  context: 'Context 甲🙂\n'.repeat(999),
  expectedRevision: 0,
};

test('project save admits one revision and notifies only durable committed state', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'neo-project-save-writer-'));
  const path = join(folder, 'synthetic.db');
  const writer = new Database(path);
  writer.exec('PRAGMA journal_mode=WAL');
  createTables(writer);
  runMigrations(writer, () => {});
  const observer = new Database(path, { readonly: true });
  const main = new Database(':memory:');
  const gateway = new DbGateway(':memory:', writer);
  bindGateway(main, gateway);
  const published: number[][] = [];
  const save = createNeoProjectSavePipeline(new NeoRepository(main), () =>
    published.push(new NeoRepository(observer).listProjects().map((p) => p.revision))
  );
  const guard = spyOn(main, 'prepare').mockImplementation(((sql: string) => {
    throw new Error(`Project SQL on main: ${sql}`);
  }) as typeof main.prepare);
  try {
    const created = await save(input, caller);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('Synthetic create failed');
    expect(created.project.context).toBe(input.context);
    expect(published).toEqual([[1]]);
    const results = await Promise.all(
      ['A', 'B'].map((title) =>
        save({ ...input, id: created.project.id, title, expectedRevision: 1 }, caller)
      )
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: 'superseded: read the current project before saving again' },
    ]);
    expect(published).toEqual([[1], [2]]);
    writer.exec(
      "CREATE TRIGGER reject_project_update BEFORE UPDATE ON neo_concerns BEGIN SELECT RAISE(ABORT,'synthetic project rejection'); END"
    );
    await expect(
      save({ ...input, id: created.project.id, expectedRevision: 2 }, caller)
    ).rejects.toThrow('synthetic project rejection');
    expect(published).toEqual([[1], [2]]);
    expect(new NeoRepository(observer).getProject(created.project.id)?.revision).toBe(2);
    const denied = await save(input, {
      source: 'mcp',
      sessionId: 'unbound',
    });
    expect(denied).toEqual({ ok: false, reason: 'This operation belongs to Neo.' });
    expect(published).toEqual([[1], [2]]);
  } finally {
    guard.mockRestore();
    await gateway.close();
    main.close();
    observer.close();
    writer.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
