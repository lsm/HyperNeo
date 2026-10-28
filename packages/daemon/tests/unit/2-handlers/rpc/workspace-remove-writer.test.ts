import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { setupWorkspaceHandlers } from '../../../../src/lib/rpc-handlers/workspace-handlers';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { WorkspaceHistoryRepository } from '../../../../src/storage/repositories/workspace-history-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

class FaultGateway extends DbGateway {
  writes = 0;
  failBefore = false;
  loseReply = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== 'workspace.history.remove.write') return super.run(op, args);
    this.writes++;
    if (this.failBefore) throw new Error('synthetic removal admission failure');
    const result = await super.run(op, args);
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('synthetic committed removal reply lost; outcome unknown');
    }
    return result;
  }
}

describe('workspace.remove DB writer', () => {
  let main: Database;
  let writer: Database;
  let gateway: FaultGateway;
  let repo: WorkspaceHistoryRepository;
  let remove: (input: unknown) => Promise<{ success: boolean }>;
  let mainSql: number;
  beforeEach(() => {
    main = new Database(':memory:');
    writer = new Database(':memory:');
    writer.exec('PRAGMA foreign_keys=ON');
    runMigrations(writer, () => {});
    createTables(writer);
    gateway = new FaultGateway(':memory:', writer);
    bindGateway(main, gateway);
    repo = new WorkspaceHistoryRepository(writer);
    mainSql = 0;
    main.prepare = () => {
      mainSql++;
      throw new Error('workspace removal SQL reached main');
    };
    const handlers = new Map<string, (input: unknown) => unknown>();
    const hub = {
      onRequest: (name: string, handler: (input: unknown) => unknown) => {
        handlers.set(name, handler);
      },
    } as unknown as MessageHub;
    setupWorkspaceHandlers(hub, new WorkspaceHistoryRepository(main));
    remove = async (input) =>
      (await handlers.get('workspace.remove')!(input)) as { success: boolean };
  });
  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
  });
  const seed = (path = '/synthetic/workspace') => {
    expect(repo.addProjectFolder(path, path, 'Synthetic project')).toBe(true);
    return path;
  };
  const projects = () => writer.prepare('SELECT id FROM workspace_projects').all();
  const memberships = () => writer.prepare('SELECT path FROM workspace_project_folders').all();

  test('public removal commits history, membership and last-project cleanup without main SQL', async () => {
    const path = seed();
    expect(await remove({ path })).toEqual({ success: true });
    expect(repo.get(path)).toBeNull();
    expect(projects()).toEqual([]);
    expect(memberships()).toEqual([]);
    expect(gateway.writes).toBe(1);
    expect(mainSql).toBe(0);
  });
  test('a remaining project folder keeps its project and history', async () => {
    expect(
      repo.addProjectFolder('/synthetic/one', '/synthetic/two', 'Synthetic shared project')
    ).toBe(true);
    expect(await remove({ path: '/synthetic/one' })).toEqual({ success: true });
    expect(repo.get('/synthetic/one')).toBeNull();
    expect(repo.get('/synthetic/two')).not.toBeNull();
    expect(projects()).toHaveLength(1);
    expect(memberships()).toEqual([{ path: '/synthetic/two' }]);
    expect(mainSql).toBe(0);
  });
  test('missing paths retain false while legacy empty-project cleanup still runs', async () => {
    writer
      .prepare('INSERT INTO workspace_projects(id,name) VALUES(?,?)')
      .run('synthetic-orphan', 'Synthetic orphan');
    expect(await remove({ path: '/synthetic/absent' })).toEqual({ success: false });
    expect(projects()).toEqual([]);
    expect(mainSql).toBe(0);
  });
  test('a cleanup failure rolls back the history delete and membership cascade', async () => {
    const path = seed();
    const before = projects();
    writer.exec(
      "CREATE TRIGGER reject_workspace_cleanup BEFORE DELETE ON workspace_projects BEGIN SELECT RAISE(ABORT, 'synthetic workspace cleanup failure'); END"
    );
    await expect(remove({ path })).rejects.toThrow('synthetic workspace cleanup failure');
    expect(repo.get(path)).not.toBeNull();
    expect(projects()).toEqual(before);
    expect(memberships()).toEqual([{ path }]);
    expect(mainSql).toBe(0);
  });
  test('concurrent removals preserve one winner', async () => {
    const path = seed();
    const receipts = await Promise.all([remove({ path }), remove({ path })]);
    expect(receipts.map((r) => r.success).sort()).toEqual([false, true]);
    expect(repo.get(path)).toBeNull();
    expect(projects()).toEqual([]);
    expect(gateway.writes).toBe(2);
    expect(mainSql).toBe(0);
  });
  test('failed admission leaves the workspace present and never replays', async () => {
    const path = seed();
    gateway.failBefore = true;
    await expect(remove({ path })).rejects.toThrow('synthetic removal admission failure');
    expect(repo.get(path)).not.toBeNull();
    expect(projects()).toHaveLength(1);
    expect(gateway.writes).toBe(1);
    expect(mainSql).toBe(0);
  });
  test('unknown commit outcomes retain the error without automatic replay', async () => {
    const path = seed();
    gateway.loseReply = true;
    await expect(remove({ path })).rejects.toThrow('outcome unknown');
    expect(repo.get(path)).toBeNull();
    expect(projects()).toEqual([]);
    await new Promise((done) => setTimeout(done, 100));
    expect(gateway.writes).toBe(1);
    expect(await remove({ path })).toEqual({ success: false });
    expect(gateway.writes).toBe(2);
    expect(mainSql).toBe(0);
  });
  test('invalid paths are rejected before worker admission', async () => {
    for (const input of [{}, { path: '' }, { path: 42 }])
      await expect(remove(input)).rejects.toThrow('path is required');
    expect(gateway.writes).toBe(0);
    expect(mainSql).toBe(0);
  });
});
