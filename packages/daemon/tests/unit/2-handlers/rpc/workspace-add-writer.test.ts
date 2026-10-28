import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageHub, WorkspaceHistoryEntry } from '@hyperneo/shared';
import type { McpImportService } from '../../../../src/lib/mcp/mcp-import-service';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
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
  beforeWrite?: () => Promise<void>;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== 'workspace.history.upsert.write') return super.run(op, args);
    this.writes++;
    await this.beforeWrite?.();
    if (this.failBefore) throw new Error('synthetic add admission failure');
    const result = await super.run(op, args);
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('synthetic add committed reply lost; outcome unknown');
    }
    return result;
  }
}

describe('workspace.add DB writer', () => {
  let main: Database;
  let writer: Database;
  let gateway: FaultGateway;
  let repo: WorkspaceHistoryRepository;
  let root: string;
  let path: string;
  let mainSql: number;
  let add: (input: unknown) => Promise<{ entry: WorkspaceHistoryEntry }>;
  const refresh = vi.fn();
  const publish = vi.fn();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hyperneo-add-'));
    path = join(root, 'workspace');
    mkdirSync(path);
    main = new Database(':memory:');
    writer = new Database(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    gateway = new FaultGateway(':memory:', writer);
    bindGateway(main, gateway);
    repo = new WorkspaceHistoryRepository(writer);
    mainSql = 0;
    main.prepare = ((sql: string) => {
      if (/INSERT\s+INTO\s+workspace_history|FROM\s+workspace_history\s+WHERE\s+path/i.test(sql)) {
        mainSql++;
        throw new Error('workspace-add SQL reached main');
      }
      return writer.prepare(sql);
    }) as typeof main.prepare;
    refresh.mockReset().mockImplementation(async (received: string) => {
      expect(received).toBe(path);
      expect(repo.get(path)?.use_count).toBeGreaterThan(0);
      return { added: 1, updated: 0, removed: 0 };
    });
    publish.mockReset().mockResolvedValue(undefined);
    const handlers = new Map<string, (input: unknown) => unknown>();
    const hub = {
      onRequest: (name: string, handler: (input: unknown) => unknown) =>
        handlers.set(name, handler),
    } as unknown as MessageHub;
    setupWorkspaceHandlers(
      hub,
      new WorkspaceHistoryRepository(main),
      { refreshAllForPath: refresh } as unknown as McpImportService,
      { publishAsync: publish } as unknown as InternalEventBus<DaemonInternalEventMap>
    );
    add = async (input) =>
      (await handlers.get('workspace.add')!(input)) as { entry: WorkspaceHistoryEntry };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await gateway.close();
    main.close();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  });
  test('commits before scan and returns the post-refresh enriched entry without main writes', async () => {
    refresh.mockImplementationOnce(async () => {
      expect(repo.get(path)?.use_count).toBe(1);
      repo.addProjectFolder(path, path, 'Synthetic project');
      return { added: 1, updated: 0, removed: 0 };
    });
    const result = await add({ path });
    expect(result.entry).toEqual({
      path,
      lastUsedAt: expect.any(Number),
      useCount: 2,
      project: { id: expect.any(String), name: 'Synthetic project', folders: [path] },
    });
    expect(gateway.writes).toBe(1);
    expect(publish).toHaveBeenCalledWith('mcp.registry.changed', { sessionId: 'global' });
    expect(mainSql).toBe(0);
  });
  test('waits for admission before scan, then retains the caller timestamp', async () => {
    let release!: () => void;
    let entered!: () => void;
    const posted = new Promise<void>((done) => {
      entered = done;
    });
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    gateway.beforeWrite = async () => {
      entered();
      await blocked;
    };
    const before = Date.now();
    const result = add({ path });
    await Promise.race([
      posted,
      result.then(() => {
        throw new Error('add completed before writer admission');
      }),
    ]);
    const capturedBefore = Date.now();
    expect(refresh).not.toHaveBeenCalled();
    expect(repo.get(path)).toBeNull();
    await new Promise((done) => setTimeout(done, 30));
    release();
    const receipt = await result;
    expect(receipt.entry.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(receipt.entry.lastUsedAt).toBeLessThanOrEqual(capturedBefore);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  test('keeps duplicate counters and normalized directory paths', async () => {
    await add({ path: '  ' + path + '  ' });
    expect((await add({ path })).entry.useCount).toBe(2);
    expect(gateway.writes).toBe(2);
    expect(mainSql).toBe(0);
  });
  test('admission refusal never scans or publishes and leaves no history row', async () => {
    gateway.failBefore = true;
    await expect(add({ path })).rejects.toThrow('admission failure');
    expect(repo.get(path)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(gateway.writes).toBe(1);
  });
  test('unknown commit outcome never replays or starts the dependent scan', async () => {
    gateway.loseReply = true;
    await expect(add({ path })).rejects.toThrow('outcome unknown');
    expect(repo.get(path)?.use_count).toBe(1);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.writes).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect((await add({ path })).entry.useCount).toBe(2);
  });
  test('preserves history success when scan throws without publishing a change', async () => {
    refresh.mockRejectedValueOnce(new Error('synthetic scan failure'));
    expect((await add({ path })).entry.useCount).toBe(1);
    expect(repo.get(path)?.use_count).toBe(1);
    expect(publish).not.toHaveBeenCalled();
  });
  test('unchanged or failed import results publish nothing', async () => {
    for (const status of ['ok', 'failed', 'malformed']) {
      refresh.mockResolvedValueOnce({ status, added: 0, updated: 0, removed: 0 });
      await add({ path });
    }
    expect(repo.get(path)?.use_count).toBe(3);
    expect(publish).not.toHaveBeenCalled();
  });
  test('invalid inputs and missing/non-directory paths never admit writes or scan', async () => {
    const file = join(root, 'file');
    writeFileSync(file, 'synthetic');
    for (const input of [
      {},
      { path: '' },
      { path: 42 },
      { path: ' ' },
      { path: file },
      { path: join(root, 'absent') },
    ])
      await expect(add(input)).rejects.toThrow();
    expect(gateway.writes).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(mainSql).toBe(0);
  });
});

test('workspace.add audited dependency files keep their exact source contract', () => {
  const root = new URL('../../../../../../', import.meta.url);
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        '.claude/skills/verify/evidence/lane-c-workspace-add/audited-dependencies.json',
        root
      ),
      'utf8'
    )
  ) as { fullTransitiveGraphMeasured: boolean; units: { file: string; sha256: string }[] };
  expect(manifest.fullTransitiveGraphMeasured).toBe(false);
  for (const unit of manifest.units)
    expect(
      createHash('sha256')
        .update(readFileSync(new URL(unit.file, root)))
        .digest('hex')
    ).toBe(unit.sha256);
});
