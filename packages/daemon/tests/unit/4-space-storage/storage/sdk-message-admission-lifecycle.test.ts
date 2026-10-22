import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import {
  startSdkBodyWriteAdmission,
  type SdkBodyWriteMode,
} from '../../../../src/storage/sdk-message-body-admission.ts';

let db: Database;
let repo: SDKMessageRepository;
let cancel: () => void;
const modes: SdkBodyWriteMode[] = [];
const worker = {
  onmessage: null as ((event: MessageEvent<SdkBodyWriteMode>) => void) | null,
  onerror: null as ((event: ErrorEvent) => void) | null,
  postMessage(_value: unknown) {},
  terminate() {},
};
const body = 'Complete synthetic tool output';
const save = (uuid: string) => {
  repo.saveSDKMessage('s', { type: 'result', uuid, result: body } as SDKMessage);
  expect(repo.getMessageByUuid('s', uuid)).toMatchObject({ result: body });
  return db.prepare('SELECT sdk_message FROM sdk_messages WHERE sdk_uuid=?').get(uuid);
};
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec(`PRAGMA foreign_keys=OFF;
    INSERT INTO migration_markers VALUES ('sdk_message_bodies_copy_v1:complete',1)`);
  repo = new SDKMessageRepository(db);
  modes.length = 0;
  cancel = startSdkBodyWriteAdmission(
    db,
    '/synthetic/daemon.db',
    (mode) => modes.push(mode),
    () => worker as unknown as Worker
  );
});
afterEach(() => {
  cancel();
  db.close();
});

test('new inputs stay fully readable and dual-written while historical coverage is pending', () => {
  expect(save('pending')).toEqual({
    sdk_message: JSON.stringify({ type: 'result', uuid: 'pending', result: body }),
  });
  worker.onmessage!({
    data: { mode: 'side-only', reason: null },
  } as MessageEvent<SdkBodyWriteMode>);
  expect(save('verified')).toEqual({ sdk_message: '' });
  expect(modes).toEqual([
    { mode: 'dual-write', reason: 'coverage_pending' },
    { mode: 'side-only', reason: null },
  ]);
});

test.each(['body_missing', 'coverage_worker_failed'])(
  'new inputs retain both complete bodies when verification returns %s',
  (reason) => {
    worker.onmessage!({ data: { mode: 'dual-write', reason } } as MessageEvent<SdkBodyWriteMode>);
    expect(save(reason)).toEqual({
      sdk_message: JSON.stringify({ type: 'result', uuid: reason, result: body }),
    });
  }
);

test('closing the database ignores a late verification result', () => {
  cancel();
  worker.onmessage!({
    data: { mode: 'side-only', reason: null },
  } as MessageEvent<SdkBodyWriteMode>);
  expect(save('closed')).toEqual({
    sdk_message: JSON.stringify({ type: 'result', uuid: 'closed', result: body }),
  });
  expect(modes).toEqual([{ mode: 'dual-write', reason: 'coverage_pending' }]);
});

test('a worker startup failure preserves complete inputs in dual-write mode', () => {
  cancel();
  cancel = startSdkBodyWriteAdmission(
    db,
    '/synthetic/daemon.db',
    (mode) => modes.push(mode),
    () => {
      throw new Error('synthetic unavailable worker');
    }
  );
  expect(save('unavailable')).toEqual({
    sdk_message: JSON.stringify({ type: 'result', uuid: 'unavailable', result: body }),
  });
  expect(modes.at(-1)).toEqual({ mode: 'dual-write', reason: 'coverage_worker_unavailable' });
});
