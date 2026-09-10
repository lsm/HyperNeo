import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  checkResumeHealth,
  rejoinGlobalChannel,
  rejoinActiveSpace,
  refreshResumeStores,
  runConnectionResume,
  type ConnectionResumeEffects,
} from '../connection-resume-pipeline';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const calls: string[] = [];
  const effects: ConnectionResumeEffects = {
    checkHealth: async () => {
      calls.push('health');
    },
    joinChannel: async (channel) => {
      calls.push(`join:${channel}`);
    },
    getActiveSpaceId: () => 'space-1',
    refreshSessions: async () => {
      calls.push('sessions');
    },
    refreshApp: async () => {
      calls.push('app');
    },
    refreshGlobal: async () => {
      calls.push('global');
    },
    refreshSpace: async () => {
      calls.push('space');
    },
    recoverAgents: async () => {
      calls.push('agents');
    },
  };
  return { effects, calls };
}
const refreshMethods = [
  'refreshSessions',
  'refreshApp',
  'refreshGlobal',
  'refreshSpace',
  'recoverAgents',
] as const;
const refreshCalls = ['sessions', 'app', 'global', 'space', 'agents'];

describe('connection resume stages', () => {
  it('delegates health and global join without replacing their promises', () => {
    const { effects } = fixture();
    const gate = deferred();
    effects.checkHealth = () => gate.promise;
    effects.joinChannel = vi.fn(() => gate.promise);
    expect(checkResumeHealth(effects)).toBe(gate.promise);
    expect(rejoinGlobalChannel(effects)).toBe(gate.promise);
    expect(effects.joinChannel).toHaveBeenCalledWith('global');
    gate.resolve();
  });

  it.each([null, '', 'space-2'])('reads active space %s at invocation', async (spaceId) => {
    const { effects, calls } = fixture();
    effects.getActiveSpaceId = () => spaceId;
    await rejoinActiveSpace(effects);
    expect(calls).toEqual(spaceId ? [`join:space:${spaceId}`] : []);
  });

  it('starts all refreshes in the existing invocation order', async () => {
    const { effects, calls } = fixture();
    await refreshResumeStores(effects);
    expect(calls).toEqual(refreshCalls);
  });
});

describe('runConnectionResume', () => {
  it('awaits health and each join, reading the selected space after global join', async () => {
    const { effects, calls } = fixture();
    const health = deferred();
    const global = deferred();
    const space = deferred();
    let activeSpace = 'old';
    effects.checkHealth = () => {
      calls.push('health');
      return health.promise;
    };
    effects.getActiveSpaceId = () => activeSpace;
    effects.joinChannel = (channel) => {
      calls.push(`join:${channel}`);
      return channel === 'global' ? global.promise : space.promise;
    };
    const pending = runConnectionResume(effects);
    await setImmediate();
    expect(calls).toEqual(['health']);
    health.resolve();
    await setImmediate();
    expect(calls).toEqual(['health', 'join:global']);
    activeSpace = 'new';
    global.resolve();
    await setImmediate();
    expect(calls).toEqual(['health', 'join:global', 'join:space:new']);
    space.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(calls).toEqual(['health', 'join:global', 'join:space:new', ...refreshCalls]);
  });

  it.each(refreshMethods)('waits for %s while other refreshes finish', async (method) => {
    const { effects, calls } = fixture();
    const gate = deferred();
    effects[method] = () => {
      calls.push('held');
      return gate.promise;
    };
    let settled = false;
    const pending = runConnectionResume(effects).then(() => {
      settled = true;
    });
    await setImmediate();
    expect(calls).toHaveLength(8);
    expect(settled).toBe(false);
    gate.resolve();
    await pending;
    expect(settled).toBe(true);
  });

  it.each([
    'checkHealth',
    'refreshApp',
    'refreshGlobal',
  ] as const)('propagates %s rejection to the owner', async (method) => {
    const { effects, calls } = fixture();
    const failure = new Error(method);
    effects[method] = async () => {
      throw failure;
    };
    await expect(runConnectionResume(effects)).rejects.toBe(failure);
    if (method === 'checkHealth') expect(calls).toEqual([]);
  });

  it('continues when a channel dependency resolves after handling its own failure', async () => {
    const { effects, calls } = fixture();
    effects.joinChannel = async (channel) => {
      calls.push(`handled:${channel}`);
    };
    await runConnectionResume(effects);
    expect(calls).toEqual(['health', 'handled:global', 'handled:space:space-1', ...refreshCalls]);
  });

  it('omits the space join when no space is selected', async () => {
    const { effects, calls } = fixture();
    effects.getActiveSpaceId = () => null;
    await runConnectionResume(effects);
    expect(calls).toEqual(['health', 'join:global', ...refreshCalls]);
  });
});
