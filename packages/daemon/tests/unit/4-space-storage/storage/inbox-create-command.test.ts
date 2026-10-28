import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { InboxItem } from '@hyperneo/shared';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import type { DbOp } from '../../../../src/storage/db-gateway/db-op';
import { DB_OPS } from '../../../../src/storage/db-gateway/db-ops';
import {
  InboxItemRepository,
  type CreateInboxItemParams,
} from '../../../../src/storage/repositories/inbox-item-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

const name = 'github.inbox.create.write';
const params: CreateInboxItemParams = {
  source: 'github_issue',
  repository: 'synthetic/inbox',
  issueNumber: 42,
  title: "Synthetic ' 工作区",
  body: 'Synthetic body',
  author: 'synthetic',
  labels: ['test'],
  securityCheck: { passed: true, injectionRisk: 'none' },
  rawEvent: { nested: { literal: 'synthetic' } },
};
class FaultGateway extends DbGateway {
  writes = 0;
  failBefore = false;
  loseReply = false;
  override async run<A, R>(op: DbOp<A, R>, args: A): Promise<R> {
    if (op.name !== name) return super.run(op, args);
    this.writes++;
    if (this.failBefore) throw new Error('synthetic inbox admission failure');
    const result = await super.run(op, args);
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('synthetic committed inbox reply lost; outcome unknown');
    }
    return result;
  }
}
describe('GitHub inbox create command construction', () => {
  let db: Database;
  let repo: InboxItemRepository;
  let gateway: FaultGateway;
  const id = '11111111-1111-4111-8111-111111111111';
  const now = 1_000_000;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    repo = new InboxItemRepository(db);
    gateway = new FaultGateway(':memory:', db);
  });
  afterEach(async () => {
    await gateway.close();
    db.close();
    vi.restoreAllMocks();
  });
  const create = async (target = id, at = now, input = params): Promise<InboxItem> => {
    const op = DB_OPS.get(name);
    if (!op) throw new Error('Unknown DB operation: ' + name);
    return await gateway.run(op as DbOp<unknown, InboxItem>, {
      method: 'create',
      args: [input, target, at],
    });
  };
  test('legacy createItem(params) still allocates a UUID and default time', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const item = repo.createItem(params);
    expect(item.id).toMatch(/^[\da-f-]{36}$/);
    expect(item.receivedAt).toBe(now);
    expect(item.updatedAt).toBe(now);
    expect(item.status).toBe('pending');
    expect(repo.getItem(item.id)).toEqual(item);
  });
  test('registered writer returns the exact committed plain row with caller identity and time', async () => {
    const item = await create();
    expect(DB_OPS.get(name)?.mode).toBe('write');
    expect(item).toEqual({
      ...params,
      id,
      receivedAt: now,
      updatedAt: now,
      status: 'pending',
      commentId: undefined,
      authorPermission: undefined,
      routedToRoomId: undefined,
      routedAt: undefined,
    });
    expect(repo.getItem(id)).toEqual(item);
    expect(structuredClone(item)).toEqual(item);
  });
  test('committed table changes are announced only after the receipt succeeds', async () => {
    const notices: string[] = [];
    gateway.onChanges = (changes) => {
      expect(repo.getItem(id)?.id).toBe(id);
      notices.push(...changes.map((change) => change.table));
    };
    await create();
    expect(notices).toEqual(['inbox_items']);
    vi.spyOn(InboxItemRepository.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('synthetic inbox receipt failure');
    });
    await expect(create('22222222-2222-4222-8222-222222222222')).rejects.toThrow(
      'synthetic inbox receipt failure'
    );
    expect(notices).toEqual(['inbox_items']);
  });
  test('optional metadata and nested JSON survive round-trip literally', async () => {
    const item = await create(id, now, {
      ...params,
      source: 'github_comment',
      commentId: 'comment-1',
      authorPermission: 'write',
      labels: ["quoted-'中文"],
      rawEvent: { title: "'; DROP TABLE inbox_items; --", flags: [true, null] },
    });
    expect(item.commentId).toBe('comment-1');
    expect(item.authorPermission).toBe('write');
    expect(item.rawEvent).toEqual({ title: "'; DROP TABLE inbox_items; --", flags: [true, null] });
    expect(repo.listItems()).toHaveLength(1);
  });
  test('duplicate identity has one concurrent winner and never changes its receipt', async () => {
    const outcomes = await Promise.allSettled([create(id, now), create(id, now + 1)]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(repo.listItems()).toHaveLength(1);
    expect(repo.getItem(id)?.receivedAt).toBe(now);
  });
  test('receipt-read failure rolls back insertion', async () => {
    vi.spyOn(InboxItemRepository.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('synthetic inbox receipt failure');
    });
    await expect(create()).rejects.toThrow('synthetic inbox receipt failure');
    expect(repo.getItem(id)).toBeNull();
    expect(repo.countByStatus('pending')).toBe(0);
  });
  test('malformed receipt JSON rolls back the row and trigger effects', async () => {
    db.exec(
      "CREATE TRIGGER corrupt_inbox_receipt AFTER INSERT ON inbox_items BEGIN UPDATE inbox_items SET security_check='{invalid' WHERE id=NEW.id; END"
    );
    await expect(create()).rejects.toThrow(/JSON|json|property|Unexpected|Expected|position/);
    expect(repo.getItem(id)).toBeNull();
    expect(repo.countByStatus('pending')).toBe(0);
  });
  test('admission failure leaves no row and never automatically retries', async () => {
    gateway.failBefore = true;
    await expect(create()).rejects.toThrow('admission failure');
    expect(repo.getItem(id)).toBeNull();
    expect(gateway.writes).toBe(1);
  });
  test('lost committed reply keeps one row and never replays', async () => {
    gateway.loseReply = true;
    await expect(create()).rejects.toThrow('outcome unknown');
    expect(repo.getItem(id)?.receivedAt).toBe(now);
    await new Promise((done) => setTimeout(done, 30));
    expect(gateway.writes).toBe(1);
    expect(repo.listItems()).toHaveLength(1);
    await expect(create()).rejects.toThrow();
    expect(gateway.writes).toBe(2);
    expect(repo.getItem(id)?.receivedAt).toBe(now);
  });
});
