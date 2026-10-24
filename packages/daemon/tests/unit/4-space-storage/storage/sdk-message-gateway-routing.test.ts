import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database as FacadeDatabase } from '../../../../src/storage/index';
import { describe, expect, test } from 'bun:test';
import {
  bindGateway,
  DbGateway,
  type DbGatewayRequest,
  type DbGatewayReply,
} from '../../../../src/storage/db-gateway/db-gateway';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { sdkMessageWrites } from '../../../../src/storage/repositories/sdk-message-writes';
import { Database } from '../../../../src/storage/sqlite-compat';

class Writer {
  onmessage: ((event: MessageEvent<DbGatewayReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requests: DbGatewayRequest[] = [];
  constructor() {
    queueMicrotask(() =>
      this.onmessage?.({ data: { ready: true } } as MessageEvent<DbGatewayReply>)
    );
  }
  postMessage(request: DbGatewayRequest) {
    structuredClone(request);
    this.requests.push(request);
    queueMicrotask(() =>
      this.onmessage?.({ data: { id: request.id, result: null } } as MessageEvent<DbGatewayReply>)
    );
  }
  terminate() {}
}

describe('SDK message gateway routing', () => {
  test('every registered SDK writer posts to the gateway without using the main connection', async () => {
    const main = new Database(':memory:');
    main.exec('PRAGMA query_only=ON');
    const workers: Writer[] = [];
    const gateway = new DbGateway('/synthetic.db', null, undefined, () => {
      const worker = new Writer();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    bindGateway(main, gateway);
    const repository = new SDKMessageRepository(main);
    try {
      for (const method of sdkMessageWrites.methods) {
        const write = repository.write as (method: string) => Promise<unknown>;
        await write.call(repository, method);
      }
      expect(workers).toHaveLength(1);
      expect(
        workers[0].requests.map((request) => ({
          lane: request.lane,
          op: request.op,
          args: request.args,
        }))
      ).toEqual(
        sdkMessageWrites.methods.map((method) => ({
          lane: 'write',
          op: 'sdk_messages.write',
          args: { method, args: [], sdkSideOnlyWrites: false },
        }))
      );
    } finally {
      await gateway.close();
      main.close();
    }
  });
});

test('every facade SDK writer uses the gateway without a proxy write', async () => {
  const main = new Database(':memory:');
  main.exec('PRAGMA query_only=ON');
  const writer = new Writer();
  const gateway = new DbGateway(
    '/synthetic.db',
    null,
    undefined,
    () => writer as unknown as Worker
  );
  bindGateway(main, gateway);
  const facade = {
    sdkMessageRepo: new SDKMessageRepository(main),
    writeSDKMessage: FacadeDatabase.prototype.writeSDKMessage,
  };
  const methods = [
    'saveSDKMessage',
    'saveUserMessage',
    'updateMessageStatus',
    'updateMessageTimestamp',
    'deletePendingUserMessage',
    'deferEnqueuedUserMessage',
    'deleteMessagesAfter',
    'deleteMessagesAtAndAfter',
    'saveHyperNeoActionMessage',
    'updateHyperNeoActionMessage',
    'updateHyperNeoActionMessageByUuid',
  ] as const;
  try {
    for (const method of methods)
      await (FacadeDatabase.prototype[method] as (...args: never[]) => Promise<unknown>).call(
        facade
      );
    expect(
      writer.requests.map((request) => ({
        op: request.op,
        method: (request.args as { method: string }).method,
      }))
    ).toEqual(methods.map((method) => ({ op: 'sdk_messages.write', method })));
  } finally {
    await gateway.close();
    main.close();
  }
});

test('live public SDK entry points use the real writer while main stays read-only', () => {
  const run = mkdtempSync(join(tmpdir(), 'sdk-live-routing-'));
  mkdirSync(join(run, 'home'));
  try {
    const child = spawnSync('bun', ['.claude/skills/verify/sdk-message-routing.ts', run], {
      cwd: resolve(import.meta.dirname, '../../../../../..'),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: join(run, 'home'),
        NODE_ENV: 'test',
        HYPERNEO_DATA_DIR: join(run, 'data'),
        LOG_LEVEL: 'warn',
      },
    });
    expect({
      status: child.status,
      error: child.error?.message,
      stderr: child.stderr,
    }).toMatchObject({ status: 0 });
    expect(
      JSON.parse(readFileSync(join(run, 'evidence/sdk-message-routing.json'), 'utf8'))
    ).toMatchObject({
      pass: true,
      sideOnly: true,
      rollback: true,
      mainQueryOnly: { query_only: 1 },
      neo: { accepted: true },
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}, 30_000);

test('the typed live-writer inventory permits raw SDK writers only inside synchronous op units', () => {
  const child = spawnSync('bun', ['.claude/skills/verify/sdk-writer-inventory.ts'], {
    cwd: resolve(import.meta.dirname, '../../../../../..'),
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  expect({ status: child.status, error: child.error?.message, stderr: child.stderr }).toMatchObject(
    { status: 0 }
  );
  expect(JSON.parse(child.stdout)).toMatchObject({
    pass: true,
    registeredWriters: 28,
    violations: [],
  });
}, 40_000);
