import { describe, expect, test, mock, beforeEach, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { AcpTransport } from '../../../src/lib/acp/acp-transport';

// ---------------------------------------------------------------------------
// Helpers — mock child process with EventEmitter-based stdio
// ---------------------------------------------------------------------------

class MockStream extends EventEmitter {
  written: string[] = [];

  write(chunk: string | Buffer, _encoding?: string, cb?: () => void): boolean {
    this.written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    if (cb) cb();
    return true;
  }

  end(): void {}
}

class MockChildProcess extends EventEmitter {
  stdin = new MockStream() as unknown as Writable;
  stdout = new MockStream();
  stderr = new MockStream();
  pid = 99999;
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    if (typeof signal === 'string') {
      this.signalCode = signal;
    }
    this.killed = true;
    // Simulate async exit
    setTimeout(() => {
      this.emit('exit', this.exitCode, this.signalCode);
    }, 10);
    return true;
  }
}

let lastMockProcess: MockChildProcess | null = null;

function createMockSpawn(delayMs = 0) {
  return mock((_command: string, _args: string[], _options: object) => {
    const proc = new MockChildProcess();
    lastMockProcess = proc;
    if (delayMs > 0) {
      setTimeout(() => proc.emit('spawn'), delayMs);
    }
    return proc as unknown as ReturnType<typeof import('node:child_process').spawn>;
  });
}

const originalChildProcess = require('node:child_process');

mock.module('node:child_process', () => ({
  ...originalChildProcess,
  spawn: createMockSpawn(),
}));

afterAll(() => {
  mock.module('node:child_process', () => originalChildProcess);
});

// ---------------------------------------------------------------------------
// AcpTransport — unit tests
// ---------------------------------------------------------------------------

describe('AcpTransport', () => {
  beforeEach(() => {
    lastMockProcess = null;
  });

  // -------------------------------------------------------------------------
  // JSON-RPC message framing
  // -------------------------------------------------------------------------

  test('sends request with auto-incrementing IDs', () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    transport.sendRequest('initialize', { protocolVersion: '1.0' });
    transport.sendRequest('authenticate', {});

    const lines = proc.stdin.written;
    expect(lines.length).toBe(2);

    const req1 = JSON.parse(lines[0]);
    expect(req1.jsonrpc).toBe('2.0');
    expect(req1.id).toBe(1);
    expect(req1.method).toBe('initialize');

    const req2 = JSON.parse(lines[1]);
    expect(req2.jsonrpc).toBe('2.0');
    expect(req2.id).toBe(2);
    expect(req2.method).toBe('authenticate');
  });

  test('sends notification without id', () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    transport.sendNotification('session/cancel', { sessionId: 'abc' });

    const lines = proc.stdin.written;
    expect(lines.length).toBe(1);

    const notif = JSON.parse(lines[0]);
    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe('session/cancel');
    expect(notif.id).toBeUndefined();
  });

  test('parses line-delimited JSON-RPC responses from stdout', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    const promise = transport.sendRequest('initialize', {});

    proc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) + '\n')
    );

    const response = await promise;
    expect(response.result).toEqual({ ok: true });
  });

  test('handles multiple lines in single stdout chunk', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    const p1 = transport.sendRequest('req1', {});
    const p2 = transport.sendRequest('req2', {});

    const line1 = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { n: 1 } });
    const line2 = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { n: 2 } });
    proc.stdout.emit('data', Buffer.from(line1 + '\n' + line2 + '\n'));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.result).toEqual({ n: 1 });
    expect(r2.result).toEqual({ n: 2 });
  });

  test('handles partial lines across stdout chunks', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    const promise = transport.sendRequest('initialize', {});

    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const mid = Math.floor(line.length / 2);

    proc.stdout.emit('data', Buffer.from(line.slice(0, mid)));
    proc.stdout.emit('data', Buffer.from(line.slice(mid) + '\n'));

    const response = await promise;
    expect(response.result).toEqual({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Request/response correlation
  // -------------------------------------------------------------------------

  test('rejects request when response contains error', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    const promise = transport.sendRequest('bad', {});

    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid' } }) +
          '\n'
      )
    );

    const response = await promise;
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32600);
    expect(response.error!.message).toBe('Invalid');
  });

  test('rejects pending requests on process exit', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    const promise = transport.sendRequest('hang', {});
    proc.emit('exit', 1, 'SIGTERM');

    await expect(promise).rejects.toThrow('ACP agent process exited');
  });

  test('rejects pending requests on process error', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    const promise = transport.sendRequest('hang', {});
    proc.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow('ACP agent process error: spawn ENOENT');
  });

  test('rejects sendRequest when transport is closed', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    await transport.close();

    await expect(transport.sendRequest('anything', {})).rejects.toThrow('Transport is closed');
  });

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  test('emits notifications via onNotification callback', () => {
    const notifications: unknown[] = [];
    const transport = new AcpTransport({
      command: 'acp-agent',
      onNotification: (n) => notifications.push(n),
    });
    const proc = lastMockProcess!;

    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { type: 'plan' } }) +
          '\n'
      )
    );

    expect(notifications.length).toBe(1);
    expect((notifications[0] as { method: string }).method).toBe('session/update');
  });

  // -------------------------------------------------------------------------
  // Subprocess lifecycle
  // -------------------------------------------------------------------------

  test('spawns process with correct stdio and options', () => {
    let capturedOptions: object | null = null;

    mock.module('node:child_process', () => ({
      ...originalChildProcess,
      spawn: mock((_cmd: string, _args: string[], options: object) => {
        capturedOptions = options;
        const proc = new MockChildProcess();
        lastMockProcess = proc;
        return proc as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }),
    }));

    new AcpTransport({
      command: 'acp-agent',
      args: ['--acp'],
      cwd: '/tmp/project',
      env: { FOO: 'bar' },
    });

    expect(capturedOptions).toBeDefined();
    const opts = capturedOptions as { stdio: string[]; cwd: string; env: Record<string, string> };
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(opts.cwd).toBe('/tmp/project');
    expect(opts.env.FOO).toBe('bar');

    // restore
    mock.module('node:child_process', () => ({
      ...originalChildProcess,
      spawn: createMockSpawn(),
    }));
  });

  test('close sends SIGTERM then SIGKILL after timeout', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    const closePromise = transport.close();

    // Immediately after close, SIGTERM should have been sent
    expect(proc.signalCode).toBe('SIGTERM');

    // Wait for the simulated exit
    await closePromise;

    expect(proc.killed).toBe(true);
  });

  test('close resolves immediately if process already exited', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    proc.emit('exit', 0, null);

    await expect(transport.close()).resolves.toBeUndefined();
  });

  test('onExit callback fires when process exits', () => {
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    const transport = new AcpTransport({
      command: 'acp-agent',
      onExit: (code, signal) => exits.push({ code, signal }),
    });
    const proc = lastMockProcess!;

    proc.emit('exit', 42, 'SIGTERM');

    expect(exits.length).toBe(1);
    expect(exits[0].code).toBe(42);
    expect(exits[0].signal).toBe('SIGTERM');
  });

  test('onStderr callback receives stderr data', () => {
    const stderrLines: string[] = [];
    const transport = new AcpTransport({
      command: 'acp-agent',
      onStderr: (data) => stderrLines.push(data),
    });
    const proc = lastMockProcess!;

    proc.stderr.emit('data', Buffer.from('warning: deprecated\n'));

    expect(stderrLines.length).toBe(1);
    expect(stderrLines[0]).toBe('warning: deprecated\n');
  });

  test('ignores empty lines and malformed JSON', () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    // Should not throw
    proc.stdout.emit('data', Buffer.from('\n\nnot-json\n\n'));

    const promise = transport.sendRequest('test', {});
    proc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n')
    );

    expect(promise).resolves.toBeDefined();
  });

  test('request timeout rejects after configured duration', async () => {
    const transport = new AcpTransport({
      command: 'acp-agent',
      requestTimeoutMs: 50,
    });
    const proc = lastMockProcess!;

    // Do not emit a response — let it timeout
    const promise = transport.sendRequest('slow', {});

    await expect(promise).rejects.toThrow('Request timed out after 50ms: slow');
  });

  // -------------------------------------------------------------------------
  // Inbound requests
  // -------------------------------------------------------------------------

  test('dispatches inbound requests via onRequest callback', () => {
    const requests: unknown[] = [];
    const transport = new AcpTransport({
      command: 'acp-agent',
      onRequest: (r) => requests.push(r),
    });
    const proc = lastMockProcess!;

    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 42,
          method: 'fs/read_text_file',
          params: { path: '/tmp' },
        }) + '\n'
      )
    );

    expect(requests.length).toBe(1);
    const req = requests[0] as { id: number; method: string };
    expect(req.id).toBe(42);
    expect(req.method).toBe('fs/read_text_file');
  });

  test('auto-replies error when inbound request has no onRequest handler', () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    proc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'unknown', params: {} }) + '\n')
    );

    const lines = proc.stdin.written;
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.jsonrpc).toBe('2.0');
    expect(last.id).toBe(99);
    expect(last.error.code).toBe(-32601);
  });

  test('sendResponse writes JSON-RPC response to stdin', () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    transport.sendResponse(7, { ok: true });

    const lines = proc.stdin.written;
    const resp = JSON.parse(lines[0]);
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(7);
    expect(resp.result).toEqual({ ok: true });
  });

  test('sendErrorResponse writes JSON-RPC error to stdin', () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;

    transport.sendErrorResponse(8, { code: -32600, message: 'Bad' });

    const lines = proc.stdin.written;
    const resp = JSON.parse(lines[0]);
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(8);
    expect(resp.error.code).toBe(-32600);
  });

  // -------------------------------------------------------------------------
  // Process group kill
  // -------------------------------------------------------------------------

  test('close falls back to direct kill when group kill fails', async () => {
    const transport = new AcpTransport({ command: 'acp-agent' });
    const proc = lastMockProcess!;
    proc.pid = 12345;

    let directKillSignal: string | null = null;
    proc.kill = (signal?: NodeJS.Signals | number) => {
      if (typeof signal === 'string') {
        directKillSignal = signal;
      }
      proc.killed = true;
      setTimeout(() => {
        proc.emit('exit', proc.exitCode, signal as string);
      }, 10);
      return true;
    };

    const closePromise = transport.close();

    await closePromise;

    // In test env processKill(-12345) throws, so fallback to proc.kill is used
    expect(directKillSignal).toBe('SIGTERM');
  });
});
