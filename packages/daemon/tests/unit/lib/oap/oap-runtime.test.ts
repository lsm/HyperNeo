import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type { OapEngine, OapEngineOptions } from '../../../../src/lib/oap/oap-engine';
import { OapHubRequestError, type OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
import * as query from '../../../../src/lib/oap/oap-query';
import type { OapQueryRuntime } from '../../../../src/lib/agent/query-runner';

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
  let opened = false;
  const operations: Array<{ op: string; parameters: Record<string, unknown> }> = [];
  const request = mock(async (op: string, parameters: Record<string, unknown>) => {
    operations.push({ op, parameters });
    if (op === 'work.status') {
      if (status) return status;
      if (!opened) throw new OapHubRequestError('unknown_session', 'no session');
      return { directory: '/synthetic/workspace' };
    }
    if (op === 'open') {
      opened = true;
      return {
        type: 'session.open.response',
        payload: { session_id: 'session-a' },
      };
    }
    throw new Error(`unexpected operation ${op}`);
  });
  const client = { request } as unknown as OapHubClient;
  const getHub = mock(async () => client);
  const engine = { getHub } as unknown as OapEngine;
  return { engine, client, getHub, operations };
}

describe('OAP daemon runtime', () => {
  test('lazily opens the exact session workspace once, even across concurrent callers', async () => {
    const host = fixture();
    const bind = createOapRuntime(host.engine, options);
    const runtime = bind(session('session-a', '/synthetic/workspace'));
    expect(host.getHub).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([runtime.hub, runtime.hub]);
    expect(first).not.toBe(second);
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
