import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { DriverHealth } from '@hyperneo/shared/types/settings';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createNeoService } from '../../helpers/neo-service.ts';
import { createTestDb } from '../../../helpers/database.ts';

const hour = 3_600_000;
let clock: number;
let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
let now: ReturnType<typeof spyOn>;
beforeEach(async () => {
  db = await createTestDb();
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus()
  );
  spyOn(service.todoRunner, 'refresh').mockResolvedValue(undefined);
  spyOn(service.sessionWatcher, 'watchSessions').mockResolvedValue(undefined);
  clock = 10 * hour;
  now = spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  await service.dispose();
  now.mockRestore();
  db.close();
});
const health = (status: DriverHealth['status'], since: number): DriverHealth => ({
  status,
  reason: status === 'ok' ? 'Readable.' : 'State database is missing.',
  clientVersions: { desktop: '1.0.0' },
  checkedAt: since,
  unverifiedVersion: false,
  since,
});
const record = (value: DriverHealth) =>
  db.updateGlobalSettings({ driverHealth: { 'codex-desktop': value } });
const told = () =>
  (
    db
      .getDatabase()
      .prepare("SELECT payload FROM job_queue WHERE queue IN ('mailbox', 'neo_notes')")
      .all() as { payload: string }[]
  )
    .map((row) => JSON.stringify(JSON.parse(row.payload).message.message.content))
    .filter((text) => text.includes('Driver health: codex-desktop'));

test('a driver health incident reaches Neo once across sweeps, and a new incident is told again', async () => {
  service.repo.reserveBinding({ sessionId: 'neo-root', projectId: null, kind: 'neo' });
  record(health('unavailable', clock));
  await service.sweepPacks();
  clock += hour;
  await service.sweepPacks();
  expect(told()).toHaveLength(1);
  expect(told()[0]).toContain('codex-desktop unavailable. State database is missing.');
  record(health('ok', clock));
  await service.sweepPacks();
  expect(told()).toHaveLength(1);
  record(health('unavailable', clock));
  await service.sweepPacks();
  expect(told()).toHaveLength(2);
});

test('a driver health incident waits for Neo and is told once Neo exists', async () => {
  record(health('unavailable', clock));
  await service.sweepPacks();
  expect(told()).toEqual([]);
  service.repo.reserveBinding({ sessionId: 'neo-root', projectId: null, kind: 'neo' });
  await service.sweepPacks();
  await service.sweepPacks();
  expect(told()).toHaveLength(1);
});
