import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STARTUP_TIMEOUT = 30_000;
const STARTUP_POLL_INTERVAL = 500;
const RPC_TIMEOUT = 10_000;

class SmokeTestError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SmokeTestError';
  }
}

function log(msg: string) {
  console.log(`[smoke] ${msg}`);
}

async function waitForHttp(url: string, timeout: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.text();
      }
    } catch {}
    await new Promise((r) => setTimeout(r, STARTUP_POLL_INTERVAL));
  }
  throw new SmokeTestError(`Server did not become ready within ${timeout}ms`);
}

function rpcCall(
  ws: WebSocket,
  method: string,
  data: unknown = {},
  sessionId = 'global'
): Promise<{ data: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), RPC_TIMEOUT);

    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.requestId === id || msg.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener('message', handler);
        if (msg.type === 'RSP' && msg.error) {
          resolve({ data: null, error: msg.error });
        } else {
          resolve({ data: msg.data });
        }
      }
    };

    ws.addEventListener('message', handler);
    ws.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId,
        method,
        data,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
}

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('WebSocket connection timed out')),
      RPC_TIMEOUT
    );
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.addEventListener('error', (e) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${e}`));
    });
  });
}

const rawPath = process.argv[2];
if (!rawPath) {
  console.error('Usage: bun run scripts/smoke-test.ts <path-to-binary>');
  process.exit(1);
}
const binaryPath = resolve(rawPath);

const net = await import('node:net');
const port = await new Promise<number>((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, () => {
    const addr = srv.address();
    if (addr && typeof addr === 'object') {
      const p = addr.port;
      srv.close(() => resolve(p));
    } else {
      srv.close(() => reject(new Error('Failed to get port')));
    }
  });
});

const workspace = mkdtempSync(join(tmpdir(), 'hyperneo-smoke-'));
log(`Binary: ${binaryPath}`);
log(`Port: ${port}`);
log(`Workspace: ${workspace}`);

const proc = spawn(binaryPath, ['--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production' },
});

let serverOutput = '';
proc.stdout?.on('data', (d: Buffer) => {
  serverOutput += d.toString();
});
proc.stderr?.on('data', (d: Buffer) => {
  serverOutput += d.toString();
});

const cleanup = () => {
  try {
    proc.kill('SIGTERM');
  } catch {}
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(1);
});

try {
  log('Test 1: Waiting for HTTP server...');
  const html = await waitForHttp(`http://localhost:${port}/`, STARTUP_TIMEOUT);
  if (!html.includes('<!doctype html>') && !html.includes('<!DOCTYPE html>')) {
    throw new SmokeTestError(`Expected HTML response, got: ${html.slice(0, 200)}`);
  }
  log('  PASS: Web UI served successfully');

  log('Test 2: Connecting WebSocket...');
  const ws = await connectWebSocket(`ws://localhost:${port}/ws`);

  log('Test 3: system.health RPC...');
  const health = await rpcCall(ws, 'system.health');
  const healthData = health.data as { status: string };
  if (healthData.status !== 'ok') {
    throw new SmokeTestError(`Expected status "ok", got: ${JSON.stringify(healthData)}`);
  }
  log('  PASS: system.health returned status "ok"');

  log('Test 4: session.list RPC...');
  const listResult = await rpcCall(ws, 'session.list');
  const listData = listResult.data as { sessions: unknown[] };
  if (!Array.isArray(listData.sessions)) {
    throw new SmokeTestError(`Expected sessions array, got: ${JSON.stringify(listData)}`);
  }
  log(`  PASS: session.list returned ${listData.sessions.length} sessions`);

  log('Test 5: session.create RPC...');
  const createResult = await rpcCall(ws, 'session.create', {
    workspacePath: workspace,
  });
  const createData = createResult.data as { sessionId: string };
  if (!createData.sessionId) {
    throw new SmokeTestError(`Expected sessionId, got: ${JSON.stringify(createData)}`);
  }
  const sessionId = createData.sessionId;
  log(`  PASS: Session created with ID ${sessionId}`);

  log('Test 6: session.list (verify new session)...');
  const listResult2 = await rpcCall(ws, 'session.list');
  const listData2 = listResult2.data as { sessions: Array<{ id: string }> };
  const found = listData2.sessions.some((s) => s.id === sessionId);
  if (!found) {
    throw new SmokeTestError(
      `Session ${sessionId} not found in list: ${JSON.stringify(listData2.sessions.map((s) => s.id))}`
    );
  }
  log(`  PASS: Session ${sessionId} appears in session list`);

  log('Test 7: session.delete RPC...');
  const deleteResult = await rpcCall(ws, 'session.delete', { sessionId });
  if (deleteResult.error) {
    log(`  WARN: session.delete returned error: ${deleteResult.error} (non-fatal)`);
  } else {
    log('  PASS: Session deleted');
  }

  ws.close();
  log('\nAll smoke tests passed!');
} catch (error) {
  console.error(`\n[smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  console.error('\nServer output:');
  console.error(serverOutput);
  cleanup();
  process.exit(1);
} finally {
  cleanup();
}
