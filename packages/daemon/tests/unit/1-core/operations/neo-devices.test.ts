import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createNeoDeviceOperations,
  planNeoDevice,
  requireNeoActivityDevice,
  requireNeoUser,
} from '../../../../src/lib/neo/devices.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoDeviceRepository } from '../../../../src/storage/repositories/neo-device-repository.ts';
import { runMigration315 } from '../../../../src/storage/schema/m315-neo-devices.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const user: OperationCaller = { source: 'rpc', principal: 'local' };
const neo: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
const token = 'AB'.repeat(32);
const phone = {
  deviceId: 'phone-1',
  apnsToken: token,
  environment: 'sandbox' as const,
  bundleId: 'dev.hyperneo.neo',
  kinds: ['needsYou' as const, 'done' as const, 'needsYou' as const],
};

describe('requireNeoUser', () => {
  test.each<[string, OperationCaller, boolean]>([
    ['the local user over RPC', user, true],
    ['Neo over MCP', neo, false],
    ['an unnamed RPC caller', { source: 'rpc' }, false],
    ['an internal caller', { source: 'internal', principal: 'local' }, false],
  ])('%s', (_label, caller, admitted) => {
    expect('value' in requireNeoUser(caller)).toBe(admitted);
  });
});

describe('planNeoDevice', () => {
  test('lowercases tokens, defaults the start token and drops repeated kinds', () => {
    expect(planNeoDevice(phone)).toEqual({
      deviceId: 'phone-1',
      apnsToken: 'ab'.repeat(32),
      environment: 'sandbox',
      bundleId: 'dev.hyperneo.neo',
      pushToStartToken: null,
      kinds: ['needsYou', 'done'],
    });
    expect(planNeoDevice({ ...phone, pushToStartToken: 'CD12CD12CD12CD12' }).pushToStartToken).toBe(
      'cd12cd12cd12cd12'
    );
  });
});

describe('requireNeoActivityDevice', () => {
  const input = { deviceId: 'phone-1', activityId: 'act-1', pushToken: 'EF'.repeat(16) };
  test.each<[string, boolean, ReturnType<typeof requireNeoActivityDevice>]>([
    [
      'a registered device',
      true,
      { value: { deviceId: 'phone-1', activityId: 'act-1', pushToken: 'ef'.repeat(16) } },
    ],
    [
      'an unknown device',
      false,
      { reason: { ok: false, reason: 'unknown_device: phone-1 is not registered.' } },
    ],
  ])('%s', (_label, found, expected) => {
    expect(requireNeoActivityDevice({ found }, input)).toEqual(expected);
  });
});

describe('Neo device registry over RPC', () => {
  let db: Database;
  let devices: NeoDeviceRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigration315(db);
    devices = new NeoDeviceRepository(db);
  });

  function invoke(name: string, input: unknown, caller = user) {
    return invokeOperation(
      createOperationRegistry(createNeoDeviceOperations(devices)),
      name,
      input,
      caller
    );
  }
  const activityCount = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM neo_live_activities').get() as { n: number }).n;

  test('registers a phone and its Live Activity, then forgets both', async () => {
    expect(await invoke('neo.device.register', phone)).toMatchObject({ value: { ok: true } });
    expect(devices.get('phone-1')).toMatchObject({ apnsToken: 'ab'.repeat(32) });
    expect(
      await invoke('neo.liveActivity.register', {
        deviceId: 'phone-1',
        activityId: 'act-1',
        pushToken: 'EF'.repeat(16),
      })
    ).toMatchObject({ value: { ok: true } });
    expect(activityCount()).toBe(1);

    expect(
      await invoke('neo.liveActivity.unregister', { deviceId: 'phone-1', activityId: 'act-1' })
    ).toMatchObject({ value: { ok: true, removed: true } });
    await invoke('neo.liveActivity.register', {
      deviceId: 'phone-1',
      activityId: 'act-2',
      pushToken: 'EF'.repeat(16),
    });
    expect(await invoke('neo.device.unregister', { deviceId: 'phone-1' })).toMatchObject({
      value: { ok: true, removed: true },
    });
    expect(devices.get('phone-1')).toBe(null);
    expect(activityCount()).toBe(0);
    expect(await invoke('neo.device.unregister', { deviceId: 'phone-1' })).toMatchObject({
      value: { ok: true, removed: false },
    });
  });

  test('re-registering replaces tokens, and a token moves to the device that now holds it', async () => {
    await invoke('neo.device.register', phone);
    await invoke('neo.device.register', { ...phone, environment: 'production', kinds: ['done'] });
    expect(devices.get('phone-1')).toMatchObject({ environment: 'production', kinds: ['done'] });

    await invoke('neo.device.register', { ...phone, deviceId: 'phone-2' });
    expect(devices.get('phone-1')).toBe(null);
    expect(devices.get('phone-2')).toMatchObject({ apnsToken: 'ab'.repeat(32) });
  });

  test('refuses Neo, unknown devices and tokens that are not hex', async () => {
    expect(await invoke('neo.device.register', phone, neo)).toMatchObject({
      value: { ok: false, reason: 'This action needs the user.' },
    });
    expect(devices.get('phone-1')).toBe(null);
    expect(
      await invoke('neo.liveActivity.register', {
        deviceId: 'phone-1',
        activityId: 'act-1',
        pushToken: 'EF'.repeat(16),
      })
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('unknown_device') } });
    expect(
      await invoke('neo.device.register', { ...phone, apnsToken: 'not-a-token' })
    ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
  });
});
