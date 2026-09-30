import { afterEach, beforeEach, describe, test } from 'bun:test';
import { expect, vi } from 'vitest';
import type { Session, SessionConfig, SessionMetadata } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { SessionCache } from '../../../../src/lib/session/session-cache.ts';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import {
  gateCommitOwner,
  ModelSwitchHandler,
  type ModelSwitchHandlerContext,
  type RuntimeSettingsCommit,
} from '../../../../src/lib/agent/model-switch-handler.ts';

const ID = 'fictional-session';
const NEW_MODEL = 'new-model';
const REFUSE = { reason: 'session_settings_changed' };
const REFUSED = { success: false, model: 'old-model', error: 'session_settings_changed' };
const CONFIG: SessionConfig = {
  model: 'old-model',
  provider: 'anthropic',
  maxTokens: 4096,
  temperature: 0.7,
};
const METADATA: SessionMetadata = {
  messageCount: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalCost: 0,
  toolCallCount: 0,
  acpContextUsageEstimate: 11,
  acpSessionCommand: 'fictional-acp --stdio',
};

const order: string[] = [];
let validation: Promise<void> = Promise.resolve();
let validateEntered: () => void = () => {};
let releaseValidation: () => void = () => {};

vi.mock('../../../../src/lib/model-service.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/model-service.ts')>()),
  isValidModel: vi.fn(async () => {
    order.push('validate-entered');
    validateEntered();
    await validation;
    order.push('validate-released');
    return true;
  }),
  getModelInfo: vi.fn(async (model: string) => ({ id: model })),
  resolveModelAlias: vi.fn(async (model: string) => model),
}));
vi.mock('../../../../src/lib/providers/factory.js', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/providers/factory.js')>()),
  getProviderRegistry: () => ({
    detectProviderForModel: (_model: string, provider?: string) => ({
      id: provider ?? 'anthropic',
    }),
  }),
}));

type HandleView = Session & { label: string };
function seedSession(): Session {
  return {
    id: ID,
    title: 'Fictional session',
    workspacePath: '/fictional/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: { ...CONFIG },
    metadata: METADATA,
    processingState: JSON.stringify({ status: 'idle' }),
    acpSessionId: 'fictional-acp',
    sdkSessionId: 'fictional-sdk',
    sdkOriginPath: '/fictional/origin',
  };
}
type Parked = { status?: string; queued?: boolean; query?: Promise<void> | null; late?: boolean };

describe('runtime settings commit ownership fence', () => {
  let db: Database;
  let repo: SessionRepository;
  let cache: SessionCache;
  let session: Session;
  let original: HandleView;
  let originalHandle: AgentSession;
  let handler: ModelSwitchHandler;
  let entered: Promise<void>;
  let cas: ReturnType<typeof vi.fn>;
  let updateSession: ReturnType<typeof vi.fn>;
  let restart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    order.length = 0;
    validation = new Promise<void>((r) => {
      releaseValidation = r;
    });
    entered = new Promise<void>((r) => {
      validateEntered = r;
    });
    db = new Database(':memory:');
    createTables(db);
    repo = new SessionRepository(db);
    repo.createSession(seedSession());
    session = repo.getSession(ID)!;
    const made = makeHandle('original');
    original = made.view;
    originalHandle = made.handle;
    cache = new SessionCache(
      () => originalHandle,
      () => null
    );
    cache.set(ID, originalHandle);
  });
  afterEach(() => db.close());
  function stored(): Record<string, unknown> {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(ID) as Record<string, unknown>;
  }
  function owner(): () => boolean {
    return () => cache.get(ID) === originalHandle;
  }
  function noWrite() {
    expect(cas).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  }
  function makeHandle(label: string): { view: HandleView; handle: AgentSession } {
    const view: HandleView = { ...session, label, config: { ...session.config } };
    view.metadata = { ...session.metadata };
    return { view, handle: view as unknown as AgentSession };
  }
  function fixture(parked: Parked = {}) {
    let reads = 0;
    updateSession = vi.fn();
    restart = vi.fn();
    cas = vi.fn((...a: Parameters<SessionRepository['casSessionRuntimeSettings']>) =>
      repo.casSessionRuntimeSettings(...a)
    );
    const ctx = {
      session,
      db: { updateSession, casSessionRuntimeSettings: cas },
      internalEventBus: { publish: vi.fn(async () => {}) },
      contextTracker: { setModel: vi.fn() },
      stateManager: { getState: () => ({ status: parked.status ?? 'idle' }) },
      errorManager: { handleError: vi.fn(async () => {}) },
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      lifecycleManager: { restart },
      queryObject: null,
      queryPromise: parked.query ?? null,
      messageQueue: { isRunning: () => false, hasQueuedMessages: () => parked.queued ?? false },
      getQueryGeneration: () => (parked.late && ++reads > 2 ? 1 : 0),
    } as unknown as ModelSwitchHandlerContext;
    handler = new ModelSwitchHandler(ctx);
  }
  async function run(extra: Partial<RuntimeSettingsCommit> = {}, mutate?: () => void) {
    const snap = repo.captureSessionRuntimeSettings(ID)!;
    const payload: RuntimeSettingsCommit = { snapshot: snap, ...extra };
    const pending = handler.switchModel(NEW_MODEL, 'anthropic', true, payload);
    await entered;
    order.push('mutated');
    mutate?.();
    releaseValidation();
    return { result: await pending, payload };
  }
  test.each([
    [true, { value: true }],
    [false, REFUSE],
  ])('gateCommitOwner(%s) is the named ownership decision', (owned, expected) => {
    expect(gateCommitOwner(owned)).toEqual(expected);
  });

  test('an omitted predicate keeps native behaviour with one real CAS of the original', async () => {
    fixture();
    const { result, payload } = await run();
    expect(result).toEqual({ success: true, model: NEW_MODEL });
    expect(cas).toHaveBeenCalledTimes(1);
    expect(cas.mock.calls[0][0]).toBe(payload.snapshot);
    expect(JSON.parse(payload.snapshot.config).model).toBe('old-model');
    expect(JSON.parse(stored().config as string).model).toBe(NEW_MODEL);
    expect(restart).not.toHaveBeenCalled();
  });

  test('an unchanged original owner is admitted after the deferred validation', async () => {
    fixture();
    const isCurrentOwner = vi.fn(() => {
      order.push('owner');
      return cache.get(ID) === originalHandle;
    });
    const { result } = await run({ isCurrentOwner });
    expect(result).toEqual({ success: true, model: NEW_MODEL });
    expect(order).toEqual(['validate-entered', 'mutated', 'validate-released', 'owner']);
    expect(isCurrentOwner).toHaveBeenCalledTimes(1);
    expect(cas).toHaveBeenCalledTimes(1);
  });

  const RACES: ReadonlyArray<readonly [string, (h: AgentSession) => void]> = [
    ['an actual SessionCache replacement', (h) => cache.set(ID, h)],
    ['an actual SessionCache removal', () => cache.remove(ID)],
  ];

  test.each(RACES)('%s during pending validation refuses with zero writes', async (_l, mutate) => {
    fixture();
    const beforeRow = stored();
    const beforeOriginal = JSON.stringify(original);
    const beforeSession = JSON.stringify(session);
    const replacement = makeHandle('replacement');
    const beforeReplacement = JSON.stringify(replacement.view);
    const { result } = await run({ isCurrentOwner: owner() }, () => {
      mutate(replacement.handle);
    });
    expect(result).toEqual(REFUSED);
    expect(stored()).toEqual(beforeRow);
    expect(JSON.stringify(original)).toBe(beforeOriginal);
    expect(JSON.stringify(replacement.view)).toBe(beforeReplacement);
    expect(JSON.stringify(session)).toBe(beforeSession);
    noWrite();
  });

  const COMPOSED: ReadonlyArray<readonly [string, Parked, string]> = [
    ['a queued session', { queued: true }, 'session_busy'],
    ['a processing session', { status: 'processing' }, 'session_busy'],
    ['a starting query', { query: Promise.resolve() }, 'session_busy'],
    ['a generation drift only at the commit gate', { late: true }, 'session_turn_changed'],
  ];

  test.each(COMPOSED)('%s outranks a false owner with no CAS', async (_l, parked, reason) => {
    fixture(parked);
    const beforeRow = stored();
    const { result } = await run({ isCurrentOwner: () => false });
    expect(result).toEqual({ success: false, model: 'old-model', error: reason });
    expect(stored()).toEqual(beforeRow);
    noWrite();
  });

  test('a false owner alone refuses the last gate', async () => {
    fixture();
    const beforeRow = stored();
    const { result } = await run({ isCurrentOwner: () => false });
    expect(result).toEqual(REFUSED);
    expect(stored()).toEqual(beforeRow);
    noWrite();
  });

  test('a predicate fault is an infrastructure fault with no CAS or rollback', async () => {
    fixture();
    const beforeRow = stored();
    const beforeSession = JSON.stringify(session);
    const isCurrentOwner = () => {
      throw new Error('owner lookup unavailable');
    };
    const { result } = await run({ isCurrentOwner });
    expect(result.success).toBe(false);
    expect(result.error).toContain('owner lookup unavailable');
    expect(stored()).toEqual(beforeRow);
    expect(JSON.stringify(session)).toBe(beforeSession);
    noWrite();
  });
});
