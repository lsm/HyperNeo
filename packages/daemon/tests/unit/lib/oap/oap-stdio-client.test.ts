import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OapStdioClient } from '../../../../src/lib/oap/oap-stdio-client';
import type { OapEnvelope } from '../../../../src/lib/oap/oap-stdio-client';

const endpoint = fileURLToPath(new URL('./fixtures/oap-endpoint.mjs', import.meta.url));
const clients: OapStdioClient[] = [];

function client(args: string[] = [endpoint]): OapStdioClient {
  const created = new OapStdioClient({
    command: process.execPath,
    args,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    timeoutMs: 5_000,
  });
  clients.push(created);
  return created;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(() => {
  for (const created of clients.splice(0)) created.close();
});

describe('OapStdioClient', () => {
  test('connect negotiates the agent profile and later requests cite the capability revision', async () => {
    const connected = client();
    await connected.connect();
    await connected.openSession('s-1');
    const response = await connected.request('session.open.request', { session_id: 's-1' });
    expect(response.type).toBe('session.open.response');
  });

  test('an error response rejects the request with its code', async () => {
    const connected = client();
    await connected.connect();
    await expect(connected.request('session.nonesuch.request', {})).rejects.toThrow(
      'OAP session.nonesuch.request refused: unsupported session.nonesuch.request'
    );
  });

  test('frames that answer no request reach subscribers', async () => {
    const connected = client();
    await connected.connect();
    await connected.openSession('s-1');
    const frames: Array<OapEnvelope | Error> = [];
    connected.subscribe((frame) => frames.push(frame));
    await connected.request('session.message.submit.request', {
      session_id: 's-1',
      messages: [{ role: 'user', content: 'tools' }],
      delivery: 'auto',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const types = frames.map((frame) => (frame instanceof Error ? 'error' : frame.type));
    expect(types[0]).toBe('run.started');
    expect(types.at(-1)).toBe('run.completed');
  });

  test('an endpoint that exits fails pending requests and tells subscribers', async () => {
    const exiting = client(['-e', 'process.stdin.once("data", () => process.exit(3))']);
    const failures: Error[] = [];
    exiting.subscribe((frame) => {
      if (frame instanceof Error) failures.push(frame);
    });
    await expect(exiting.connect()).rejects.toThrow('OAP endpoint exited (code=3');
    expect(failures).toHaveLength(1);
  });

  test('an endpoint that answers on another profile is refused at connect and stopped', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'oap-client-')), 'pid');
    const wrong = client([
      '-e',
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.once("data", (d) => { const r = JSON.parse(String(d)); process.stdout.write(JSON.stringify({ type: "protocol.initialize.response", in_reply_to: r.id, payload: { profile: "other" } }) + "\\n"); }); setInterval(() => {}, 1000);`,
    ]);
    await expect(wrong.connect()).rejects.toThrow('did not negotiate the agent-control-core');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitFor(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    await expect(wrong.connect()).rejects.toThrow('OAP client connects once');
  });

  test('a frame that is not an envelope fails pending requests and subscribers', async () => {
    const garbled = client([
      '-e',
      'process.stdin.once("data", () => process.stdout.write("null\\n")); setInterval(() => {}, 1000);',
    ]);
    const failures: Error[] = [];
    garbled.subscribe((frame) => {
      if (frame instanceof Error) failures.push(frame);
    });
    await expect(garbled.connect()).rejects.toThrow('not an OAP envelope');
    expect(failures.map((failure) => failure.message)).toEqual([
      'OAP endpoint wrote a line that is not an OAP envelope',
    ]);
  });
});
