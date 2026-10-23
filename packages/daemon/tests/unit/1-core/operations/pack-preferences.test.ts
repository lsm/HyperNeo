import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { MessageHub } from '@hyperneo/shared';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: ReturnType<typeof createNeoService>;
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const scope = { kind: 'repo', key: 'synthetic/repo' };
const setting = { pack: 'coding', scope, key: 'mergePolicy', value: 'review_bot' };
beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession('neo:root'));
  service = createNeoService(
    db,
    {} as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
});
afterEach(() => {
  service.dispose();
  db.close();
});
const invoke = (name: string, input: unknown, caller = human) =>
  invokeOperation(createOperationRegistry(createNeoOperations(service)), name, input, caller);

describe('pack settings operations', () => {
  test('human saves a declared setting with provenance, and anyone reads it in get/list/snapshot', async () => {
    expect(await invoke('pack.preferences.get', setting)).toMatchObject({
      value: { preference: null },
    });
    expect(await invoke('pack.preferences.set', setting)).toMatchObject({ value: { ok: true } });
    const preference = {
      pack: 'coding',
      scope,
      key: 'mergePolicy',
      value: 'review_bot',
      setBy: 'human',
      setAt: expect.any(Number),
    };
    expect(await invoke('pack.preferences.get', setting, { source: 'mcp' })).toMatchObject({
      value: { preference },
    });
    expect(await invoke('pack.preferences.list', {}, { source: 'mcp' })).toMatchObject({
      value: { preferences: [preference] },
    });
    expect(await invoke('neo.snapshot', {})).toMatchObject({
      value: { packPreferences: [preference] },
    });
    expect(await invoke('pack.preferences.set', { ...setting, value: 'human' })).toMatchObject({
      value: { ok: true },
    });
    expect(await invoke('pack.preferences.list', {})).toMatchObject({
      value: { preferences: [{ ...preference, value: 'human' }] },
    });
  });
  test.each([
    { source: 'mcp', role: 'neo' },
    { source: 'mcp', role: 'direct_task_worker' },
    { source: 'internal' },
    { source: 'rpc', principal: 'remote' },
  ] as OperationCaller[])(
    'caller policy refuses agent/nonhuman writes without changing saved settings: %j',
    async (caller) => {
      await invoke('pack.preferences.set', setting);
      expect(
        await invoke('pack.preferences.set', { ...setting, value: 'ci_only' }, caller)
      ).toMatchObject({ kind: 'failed', code: 'forbidden' });
      expect(await invoke('pack.preferences.get', setting)).toMatchObject({
        value: { preference: { value: 'review_bot' } },
      });
    }
  );
  test.each([
    { value: 'invented' },
    { key: 'reviewBot', value: '-bad' },
    { key: 'reviewBot', value: 'bad--login' },
    { key: 'humanSignoff', value: 'docs/**' },
    { key: 'unknown' },
    { key: '__proto__', scope: { kind: 'global', key: '' } },
    { key: 'constructor', scope: { kind: 'global', key: '' } },
    { pack: 'unknown' },
    { scope: { kind: 'project', key: 'synthetic' } },
  ])('refuses invalid declaration/type/scope without storing anything: %j', async (change) => {
    expect(await invoke('pack.preferences.set', { ...setting, ...change })).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke('pack.preferences.list', {})).toMatchObject({ value: { preferences: [] } });
  });
  test('repo get falls back to a pack global setting, never a default', async () => {
    expect(await invoke('pack.preferences.get', setting)).toMatchObject({
      value: { preference: null },
    });
    expect(
      await invoke('pack.preferences.set', {
        ...setting,
        scope: { kind: 'global', key: '' },
        value: 'human',
      })
    ).toMatchObject({ value: { ok: true } });
    expect(await invoke('pack.preferences.get', setting)).toMatchObject({
      value: { preference: { value: 'human', scope: { kind: 'global', key: '' } } },
    });
  });
});

test('validates every declared type and keeps false, zero, empty globs and logins intact', async () => {
  service.filePacks = [
    {
      id: 'synthetic',
      describe: 'Synthetic',
      instructions: () => null,
      preferences: {
        flag: {
          scope: 'project',
          type: { kind: 'boolean' },
          default: true,
          ask: 'Flag?',
          label: { en: 'Flag', 'zh-Hans': '标志' },
          valueLabels: {
            true: { en: 'Yes', 'zh-Hans': '是' },
            false: { en: 'No', 'zh-Hans': '否' },
          },
        },
        count: {
          label: { en: 'Count', 'zh-Hans': '数量' },
          valueLabels: {},
          scope: 'project',
          type: { kind: 'number', min: 0, max: 2 },
          default: 1,
          ask: 'Count?',
        },
      },
    },
  ];
  for (const [pack, key, value, valid] of [
    ['synthetic', 'flag', false, true],
    ['synthetic', 'flag', 'false', false],
    ['synthetic', 'count', 0, true],
    ['synthetic', 'count', -1, false],
    ['synthetic', 'count', 3, false],
    ['synthetic', 'count', Infinity, false],
    ['coding', 'reviewBot', 'hyperneo-ai-test', true],
    ['coding', 'reviewBot', 'a'.repeat(40), false],
    ['coding', 'humanSignoff', [], true],
    ['coding', 'humanSignoff', ['docs/**', 'label:needs-human'], true],
  ] as const) {
    const input = {
      pack,
      key,
      value,
      scope: { kind: pack === 'synthetic' ? 'project' : 'repo', key: 'synthetic' },
    };
    expect(await invoke('pack.preferences.set', input)).toMatchObject({ value: { ok: valid } });
    if (valid)
      expect(await invoke('pack.preferences.get', input)).toMatchObject({
        value: { preference: { value } },
      });
  }
  expect(await invoke('pack.preferences.list', { pack: 'unknown' })).toMatchObject({
    value: { preferences: [] },
  });
});
