import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@hyperneo/shared';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { OapEngine, OapEngineOptions } from '../../../../src/lib/oap/oap-engine';
import { OapHubRequestError, type OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
import { createOapRuntime } from '../../../../src/lib/oap/oap-runtime';
import type { OapQueryHub } from '../../../../src/lib/oap/oap-query';

vi.mock('@hyperneo/shared/types/oxap-harnesses', async (importOriginal) =>
  (await import('../../../helpers/synthetic-oxap-harness')).withSyntheticOxapRow(importOriginal)
);

const options: OapEngineOptions = {
  binaryPath: '/synthetic/oapx',
  identity: { version: 'synthetic', sha256: 'a'.repeat(64) },
  stateDirectory: '/synthetic/state',
  hub: { adapters: {}, environment: {} },
};
const record = { providerId: 'synthetic-memory', configJson: '{"harness":"oxap-synthetic"}' };
const bind = createOapRuntime as unknown as (
  engine: OapEngine,
  options: { installed: () => boolean; read: () => Promise<OapEngineOptions> },
  events: ReturnType<typeof createDaemonInternalEventBus>,
  db: unknown,
  messageHub: unknown,
  providerRecord: (providerId: string) => typeof record | null
) => (session: Session) => { hub: Promise<OapQueryHub>; clear(): Promise<void> };

function memoryHub(config: { known?: boolean; refuseReopen?: boolean; link?: string } = {}) {
  const operations: Array<{ op: string; params: Record<string, unknown> }> = [];
  let opened = false;
  let count = 0;
  const status = (held?: false) => ({
    ref: { adapter: 'synthetic-memory', session_id: 'session-m' },
    directory: '/synthetic/workspace',
    ...(held === false
      ? { held: false }
      : { link: config.link ?? `memory://sessions/native-${count}` }),
  });
  const request = vi.fn(async (op: string, params: Record<string, unknown>) => {
    operations.push({ op, params });
    if (op === 'work.status') {
      if (opened) return status();
      if (config.known) return status(false);
      throw new OapHubRequestError('unknown_session', 'absent');
    }
    if (op === 'capabilities')
      return {
        type: 'capabilities.response',
        capability_revision: 'm1',
        payload: { features: { 'session.open.reopen': { level: 'native' } } },
      };
    if (op === 'open') {
      const payload = (params.request as { payload: { reopen?: boolean } }).payload;
      if (payload.reopen && config.refuseReopen)
        throw new OapHubRequestError('unknown_session', 'missing');
      if (!payload.reopen) count += 1;
      opened = true;
      return { type: 'session.open.response', payload: { session_id: 'session-m' } };
    }
    if (op === 'close') {
      opened = false;
      return {};
    }
    throw new Error(`unexpected operation ${op}`);
  });
  const engine = {
    getHub: vi.fn(async () => ({ request }) as unknown as OapHubClient),
    isCurrentHub: vi.fn(() => true),
    createQueryHub: vi.fn(() => ({ submit: vi.fn(), release: vi.fn() })),
  } as unknown as OapEngine;
  const db = {
    updateSession: vi.fn(async () => 'written'),
    getSDKMessages: vi.fn(() => ({ messages: [], hasMore: false })),
    getUserMessagesByStatus: vi.fn(() => ({ messages: [], total: 0 })),
    saveSDKMessage: vi.fn(async () => true),
    getSDKMessageRepo: vi.fn(() => ({ getDeliveryContent: () => ({ inputKind: 'human' }) })),
  };
  const runtime = bind(
    engine,
    { installed: () => true, read: async () => options },
    createDaemonInternalEventBus(),
    db,
    { event: vi.fn() },
    (providerId) => (providerId === record.providerId ? record : null)
  );
  return { operations, db, runtime };
}

function session(nativeId?: string, messageCount = 0): Session {
  return {
    id: 'session-m',
    workspacePath: '/synthetic/workspace',
    sdkSessionId: nativeId,
    config: { harness: 'oxap-synthetic', provider: 'synthetic-memory' },
    metadata: { messageCount },
  } as unknown as Session;
}

describe('a second OXAP row runs open, clear and reopen from its own table entry', () => {
  it('refuses to open when the provider no longer uses the chat harness', async () => {
    const host = memoryHub();
    const moved = {
      ...session(),
      config: { harness: 'oxap-synthetic', provider: 'synthetic-memory-2' },
    };
    await expect(host.runtime(moved as unknown as Session).hub).rejects.toThrow(
      'This chat ran on OXAP Synthetic, which this provider no longer uses; start a new chat'
    );
    expect(host.operations.filter(({ op }) => op === 'open')).toEqual([]);
  });

  it('opens on the provider adapter entry and stores the id its link parser reads', async () => {
    const host = memoryHub();
    const current = session();
    await host.runtime(current).hub;
    const opens = host.operations.filter(({ op }) => op === 'open');
    expect(opens.map(({ params }) => params.adapter)).toEqual(['synthetic-memory']);
    expect(current.sdkSessionId).toBe('native-1');
  });

  it('clears into a fresh native session read by the row parser', async () => {
    const host = memoryHub();
    const current = session();
    const runtime = host.runtime(current);
    await runtime.hub;
    await runtime.clear();
    expect(host.operations.filter(({ op }) => op === 'close')).toHaveLength(1);
    expect(current.sdkSessionId).toBe('native-2');
  });

  it('reopens with the provider adapter capabilities and names the row in its recovery notice', async () => {
    const host = memoryHub({ known: true, refuseReopen: true });
    const current = session('native-0', 2);
    await host.runtime(current).hub;
    expect(
      host.operations.filter(({ op }) => op === 'capabilities').map(({ params }) => params)
    ).toEqual([{ adapter: 'synthetic-memory' }]);
    expect(current.sdkSessionId).toBe('native-1');
    const notice = JSON.stringify(host.db.saveSDKMessage.mock.calls[0]);
    expect(notice).toContain('The previous OXAP Synthetic thread cannot be resumed');
  });

  it('refuses a link the row parser does not accept', async () => {
    const host = memoryHub({ link: 'codex://threads/native-1' });
    await expect(host.runtime(session()).hub).rejects.toThrow(
      'OAP returned an invalid OXAP Synthetic thread identity'
    );
  });
});
