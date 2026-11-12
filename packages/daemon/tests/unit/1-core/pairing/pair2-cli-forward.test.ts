import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get port')));
      }
    });
    server.on('error', reject);
  });
}

function waitForServerReady(process: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Server startup timeout after ${timeoutMs}ms\nOutput: ${output}`));
    }, timeoutMs);
    const checkReady = (data: { toString(): string }) => {
      output += data.toString();
      if (output.includes('Production server running')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    process.stdout?.on('data', checkReady);
    process.stderr?.on('data', checkReady);
    process.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}\nOutput: ${output}`));
      }
    });
  });
}

describe('prod server /pair2 forwarding', () => {
  let root: string;
  let serverProcess: ChildProcess | null = null;
  let proxy: net.Server | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hyperneo-pair2-cli-'));
  });

  afterEach(async () => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
    serverProcess = null;
    if (proxy) {
      await new Promise<void>((resolve) => proxy?.close(() => resolve()));
      proxy = null;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test('serves /pair2/status and /pair2/request with the switch on', async () => {
    const port = await findAvailablePort();
    const dataDir = join(root, 'data');
    const mainPath = join(__dirname, '../../../../../cli/main.ts');

    serverProcess = spawn(
      'bun',
      [
        'run',
        mainPath,
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--workspace',
        join(root, 'workspace'),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: join(root, 'home'),
          TMPDIR: process.env.TMPDIR,
          NODE_ENV: 'test',
          HYPERNEO_DATA_DIR: dataDir,
          DB_PATH: join(dataDir, 'daemon.db'),
          HYPERNEO_PAIRING_V2: 'on',
        },
        stdio: 'pipe',
      }
    );

    await waitForServerReady(serverProcess, 30_000);

    proxy = net.createServer((client) => {
      const upstream = net.connect(port, '127.0.0.1');
      client.pipe(upstream).pipe(client);
    });
    const base = await new Promise<string>((resolve, reject) => {
      proxy?.once('error', reject);
      proxy?.listen(0, '127.0.0.1', () => {
        const address = proxy?.address();
        if (address && typeof address === 'object') {
          resolve(`http://127.0.0.1:${address.port}`);
        } else {
          reject(new Error('proxy has no address'));
        }
      });
    });

    const status = await fetch(`${base}/pair2/status?requestId=missing`);
    expect(status.status).toBe(404);
    expect(await status.json()).toEqual({ error: 'not_found' });

    const request = await fetch(`${base}/pair2/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(request.status).toBe(403);
    expect(await request.json()).toEqual({ error: 'not_allowed' });
  }, 60_000);
});
