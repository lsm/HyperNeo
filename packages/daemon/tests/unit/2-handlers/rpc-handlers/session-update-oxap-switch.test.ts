import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHub, SessionConfig } from '@hyperneo/shared';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { SpaceManager } from '../../../../../space/src/managers/space-manager';
import { setupSessionHandlers } from '../../../../src/lib/rpc-handlers/session-handlers';

vi.mock('@hyperneo/shared/types/oxap-harnesses', async (importOriginal) =>
  (await import('../../../helpers/synthetic-oxap-harness')).withSyntheticOxapRow(importOriginal)
);

type Handler = (data: unknown, context: unknown) => Promise<unknown>;

const harnessOf: Record<string, string> = {
  'anthropic-codex': 'oxap-codex',
  'synthetic-codex': 'oxap-codex',
  'synthetic-memory': 'oxap-synthetic',
};

describe('raw session.update provider switches', () => {
  let handlers: Map<string, Handler>;
  let stored: Partial<SessionConfig>;
  let updateSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = new Map();
    updateSession = vi.fn(async () => {});
    const hub = {
      onRequest: (method: string, handler: Handler) => {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
      onEvent: () => () => {},
      event: () => {},
    } as unknown as MessageHub;
    const sessionManager = {
      getSession: () => null,
      getSessionFromDB: () => ({ id: 's1', config: stored }),
      getDatabase: () => ({
        providers: {
          getProviderByProviderId: (providerId: string) =>
            harnessOf[providerId]
              ? { configJson: JSON.stringify({ harness: harnessOf[providerId] }) }
              : null,
        },
      }),
      updateSession,
    } as unknown as SessionManager;
    const events = {
      publish: async () => ({ delivered: 0, failures: [] }),
      publishAsync: () => {},
      subscribe: () => () => {},
    } as unknown as InternalEventBus<never>;
    setupSessionHandlers(hub, sessionManager, events as never, {} as SpaceManager);
  });

  const update = (config: Record<string, unknown>) =>
    handlers.get('session.update')!({ sessionId: 's1', config }, {});

  it('refuses moving a Claude Code chat to an OXAP provider without writing', async () => {
    stored = { model: 'sonnet', provider: 'anthropic' };
    await expect(update({ provider: 'anthropic-codex', model: 'gpt-5.5' })).rejects.toThrow(
      /Claude Code chat cannot move to an OXAP Codex provider/
    );
    expect(updateSession).not.toHaveBeenCalled();
    expect(stored).toEqual({ model: 'sonnet', provider: 'anthropic' });
  });

  it('refuses moving an OXAP chat to a Claude Code provider without writing', async () => {
    stored = { model: 'gpt-5.5', provider: 'anthropic-codex', harness: 'oxap-codex' };
    await expect(update({ provider: 'anthropic', model: 'sonnet' })).rejects.toThrow(
      /OXAP Codex chat cannot change its provider/
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('refuses moving an OXAP chat to another provider on the same harness', async () => {
    stored = { model: 'gpt-5.5', provider: 'anthropic-codex', harness: 'oxap-codex' };
    await expect(update({ provider: 'synthetic-codex' })).rejects.toThrow(
      /OXAP Codex chat cannot change its provider/
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('refuses moving an OXAP chat to a provider on the synthetic second row', async () => {
    stored = { model: 'gpt-5.5', provider: 'anthropic-codex', harness: 'oxap-codex' };
    await expect(update({ provider: 'synthetic-memory' })).rejects.toThrow(
      /cannot change its provider/
    );
    stored = { model: 'sonnet', provider: 'anthropic' };
    await expect(update({ provider: 'synthetic-memory' })).rejects.toThrow(
      /cannot move to an OXAP Synthetic provider/
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('passes a same-provider update on an OXAP chat', async () => {
    stored = { model: 'gpt-5.5', provider: 'anthropic-codex', harness: 'oxap-codex' };
    await update({ provider: 'anthropic-codex', autoScroll: false });
    expect(updateSession).toHaveBeenCalledWith('s1', {
      config: { provider: 'anthropic-codex', autoScroll: false },
    });
  });

  it('takes a thinking level on a row that supports one', async () => {
    stored = {
      model: 'memory',
      provider: 'synthetic-memory' as never,
      harness: 'oxap-synthetic' as never,
    };
    await update({ thinkingLevel: 'think16k' });
    expect(updateSession).toHaveBeenCalledWith('s1', { config: { thinkingLevel: 'think16k' } });
  });
});
