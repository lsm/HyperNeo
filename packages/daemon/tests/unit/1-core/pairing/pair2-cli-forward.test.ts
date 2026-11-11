import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../../../../src/config';
import { startProdServer } from '../../../../../cli/src/prod-server';

describe('prod server /pair2 forwarding', () => {
  let root: string;
  let handle: Awaited<ReturnType<typeof startProdServer>> | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hyperneo-pair2-cli-'));
    for (const name of ['NODE_ENV', 'HYPERNEO_DATA_DIR', 'HYPERNEO_PAIRING_V2']) {
      savedEnv[name] = process.env[name];
    }
    process.env.NODE_ENV = 'test';
    process.env.HYPERNEO_DATA_DIR = join(root, 'data');
    process.env.HYPERNEO_PAIRING_V2 = 'on';
  });

  afterEach(async () => {
    handle?.server.stop();
    await handle?.daemonContext.cleanup();
    handle = undefined;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test('serves /pair2/status and /pair2/request with the switch on', async () => {
    handle = await startProdServer(
      getConfig({
        port: 0,
        host: '127.0.0.1',
        dbPath: join(root, 'daemon.db'),
        workspaceRoot: join(root, 'workspace'),
      })
    );
    const base = `http://127.0.0.1:${handle.server.port}`;

    const status = await fetch(`${base}/pair2/status?requestId=missing`);
    expect(status.status).toBe(404);
    expect((await status.json()) as { error: string }).toEqual({ error: 'not_found' });

    const request = await fetch(`${base}/pair2/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(request.status).toBe(403);
    expect((await request.json()) as { error: string }).toEqual({ error: 'not_allowed' });
  }, 30_000);
});
