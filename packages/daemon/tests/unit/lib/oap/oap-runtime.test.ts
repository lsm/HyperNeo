import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { OapEngine, OapEngineOptions } from '../../../../src/lib/oap/oap-engine';
import { OapHubRequestError, type OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
import * as query from '../../../../src/lib/oap/oap-query';
import type { OapQueryRuntime } from '../../../../src/lib/agent/query-runner';
import type { OapQueryHub } from '../../../../src/lib/oap/oap-query';

const createOapRuntime = (
  query as unknown as {
    createOapRuntime(
      engine: OapEngine,
      options?: OapEngineOptions
    ): (session: Session) => OapQueryRuntime;
  }
).createOapRuntime;

const options: OapEngineOptions = {
  binaryPath: '/synthetic/oapx',
  identity: { version: 'synthetic', sha256: 'a'.repeat(64) },
  stateDirectory: '/synthetic/state',
  codexExecutable: '/synthetic/codex',
  codexHome: '/synthetic/codex-home',
};

function session(id: string, workspace: string): Session {
  return {
    id,
    workspacePath: workspace,
    config: { harness: 'codex' },
  } as Session;
}

function fixture(status?: { directory: string }) {
  const opened = new Map<string, string>();
  const operations: Array<{ op: string; parameters: Record<string, unknown> }> = [];
  const request = mock(async (op: string, parameters: Record<string, unknown>) => {
    operations.push({ op, parameters });
    if (op === 'work.status') {
      if (status) return status;
      const directory = opened.get(parameters.session_id as string);
      if (!directory) throw new OapHubRequestError('unknown_session', 'no session');
      return { directory };
    }
    if (op === 'open') {
      const envelope = parameters.request as { payload: { session_id: string } };
      const id = envelope.payload.session_id;
      opened.set(id, parameters.directory as string);
      return { type: 'session.open.response', payload: { session_id: id } };
    }
    throw new Error(`unexpected operation ${op}`);
  });
  const client = { request } as unknown as OapHubClient;
  const getHub = mock(async () => client);
  const createQueryHub = mock((_client: OapHubClient) => ({}) as OapQueryHub);
  const engine = { getHub, createQueryHub } as unknown as OapEngine;
  return { engine, client, getHub, createQueryHub, operations };
}

describe('OAP daemon runtime', () => {
  test('lazily opens the exact session workspace once, even across concurrent callers', async () => {
    const host = fixture();
    const bind = createOapRuntime(host.engine, options);
    const runtime = bind(session('session-a', '/synthetic/workspace'));
    expect(host.getHub).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([runtime.hub, runtime.hub]);
    expect(first).toBe(second);
    expect(host.createQueryHub).toHaveBeenCalledTimes(1);
    expect(host.createQueryHub).toHaveBeenCalledWith(host.client);
    expect(host.getHub).toHaveBeenCalledTimes(1);
    expect(host.getHub).toHaveBeenCalledWith(options);
    expect(host.operations.map(({ op }) => op)).toEqual(['work.status', 'open', 'work.status']);
    expect(host.operations[1].parameters).toMatchObject({
      adapter: 'codex',
      directory: '/synthetic/workspace',
      request: {
        protocol: 'open-agent-protocol',
        type: 'session.open.request',
        payload: { session_id: 'session-a' },
      },
    });
  });

  test('keeps separate query transports for sessions sharing one daemon hub', async () => {
    const host = fixture();
    const bind = createOapRuntime(host.engine, options);
    const first = bind(session('session-a', '/synthetic/workspace'));
    const second = bind(session('session-b', '/synthetic/other'));
    const [firstHub, secondHub] = await Promise.all([first.hub, second.hub]);
    expect(firstHub).not.toBe(secondHub);
    expect(await bind(session('session-a', '/synthetic/workspace')).hub).toBe(firstHub);
    expect(host.createQueryHub).toHaveBeenCalledTimes(2);
    const opens = host.operations.filter(({ op }) => op === 'open');
    expect(opens.map(({ parameters }) => parameters.directory)).toEqual([
      '/synthetic/workspace',
      '/synthetic/other',
    ]);
  });

  test('opens a worktree path instead of its parent workspace', async () => {
    const host = fixture();
    const withWorktree = {
      ...session('session-a', '/synthetic/workspace'),
      worktree: { worktreePath: '/synthetic/worktree' },
    } as Session;
    await createOapRuntime(host.engine, options)(withWorktree).hub;
    expect(host.operations.find(({ op }) => op === 'open')?.parameters.directory).toBe(
      '/synthetic/worktree'
    );
  });

  test('rejects changing an already opened session workspace', async () => {
    const host = fixture();
    const bind = createOapRuntime(host.engine, options);
    await bind(session('session-a', '/synthetic/workspace')).hub;
    await expect(bind(session('session-a', '/synthetic/other')).hub).rejects.toThrow(/workspace/i);
    expect(host.operations.filter(({ op }) => op === 'open')).toHaveLength(1);
  });

  test('refuses an existing history binding until reopen is wired', async () => {
    const host = fixture({ directory: '/synthetic/workspace' });
    const runtime = createOapRuntime(
      host.engine,
      options
    )(session('session-a', '/synthetic/workspace'));
    await expect(runtime.hub).rejects.toThrow(/resum|reopen/i);
    expect(host.operations.map(({ op }) => op)).toEqual(['work.status']);
  });

  test('does not replace a saved native session when hub history is missing', async () => {
    const host = fixture();
    const resumed = { ...session('session-a', '/synthetic/workspace'), sdkSessionId: 'native-a' };
    const runtime = createOapRuntime(host.engine, options)(resumed);
    await expect(runtime.hub).rejects.toThrow(/resum|reopen/i);
    expect(host.getHub).not.toHaveBeenCalled();
  });

  test('refuses a hub that cannot prove the requested directory', async () => {
    const host = fixture();
    let probes = 0;
    (host.client.request as ReturnType<typeof mock>).mockImplementation(async (op: string) => {
      if (op === 'work.status' && ++probes === 1)
        throw new OapHubRequestError('unknown_session', 'no session');
      if (op === 'work.status') return { directory: '/synthetic/other' };
      return {
        type: 'session.open.response',
        payload: { session_id: 'session-a' },
      };
    });
    const runtime = createOapRuntime(
      host.engine,
      options
    )(session('session-a', '/synthetic/workspace'));
    await expect(runtime.hub).rejects.toThrow(/open-directory|workspace/i);
  });

  test('refuses a missing configuration or nonabsolute workspace before launching a hub', async () => {
    const host = fixture();
    await expect(
      createOapRuntime(host.engine)(session('a', '/synthetic/workspace')).hub
    ).rejects.toThrow(/config/i);
    await expect(
      createOapRuntime(host.engine, options)(session('a', 'relative')).hub
    ).rejects.toThrow(/absolute/i);
    expect(host.getHub).not.toHaveBeenCalled();
  });
});
