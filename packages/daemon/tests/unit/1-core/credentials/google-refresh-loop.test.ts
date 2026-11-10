import { afterEach, beforeEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store.ts';
import { createGoogleConnectionRefreshLoop } from '../../../../src/lib/connections/refresh-loop.ts';
import { getGoogleConnectionService } from '../../../../src/lib/connections/operations.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let loop: ReturnType<typeof createGoogleConnectionRefreshLoop>;
let tick: () => Promise<void>;
const createStore = vi.fn(
  (sql: ConstructorParameters<typeof DatabaseCredentialStore>[0]) =>
    new DatabaseCredentialStore(sql, 'synthetic-loop-key')
);
const startLogin = vi.fn(async () => {
  throw new Error('No consent is expected');
});

beforeEach(async () => {
  db = await createTestDb();
  createStore.mockClear();
  startLogin.mockClear();
  loop = createGoogleConnectionRefreshLoop(db.getDatabase(), {
    createStore,
    startLogin,
    schedule: (run) => {
      tick = run;
      return () => {};
    },
  });
});
afterEach(async () => {
  await loop.stop();
  await db.close();
});

test('an empty instance never opens a credential vault or creates an artifact identity', async () => {
  loop.start();
  await tick();
  await tick();
  expect(createStore).not.toHaveBeenCalled();
  expect(
    db.getDatabase().prepare('SELECT COUNT(*) AS n FROM artifact_file_identity').get()
  ).toEqual({ n: 0 });
});

test('an explicit connection action uses configured dependencies and shutdown closes it even before a background refresh', async () => {
  loop.start();
  await tick();
  const service = await getGoogleConnectionService(db.getDatabase());
  expect(createStore).toHaveBeenCalledTimes(1);
  expect(service.status().state).toBe('missing');
  await loop.stop();
  expect(await service.connect({ clientId: 'synthetic-client' })).toEqual({
    state: 'failed',
    reason: 'cancelled',
  });
  expect(startLogin).not.toHaveBeenCalled();
});
