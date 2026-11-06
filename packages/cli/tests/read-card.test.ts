import { afterEach, describe, expect, test, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSessionCommand } from '../src/session-cli.ts';

describe('hyperneo read', () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'agent-read-cli-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const credential = 'a'.repeat(43);
    await writeFile(join(dir, 'local-rpc.credential'), 'h'.repeat(43), { mode: 0o600 });
    const requests: { path: string; auth: string | undefined }[] = [];
    const server = createServer((req, res) => {
      requests.push({ path: req.url!, auth: req.headers.authorization });
      if (req.url === '/ask/redirect.md') {
        res.writeHead(302, { location: '/ask/leaked.md' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        res.end('# A card\n\nStatus: doing\n');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server address');
    const base = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(dir, 'agent-read.credential'),
      JSON.stringify({ credential, origin: base }),
      { mode: 0o600 }
    );
    return { dir, requests, credential, base };
  }

  test('reads without a session identity using only the agent credential', async () => {
    const { dir, requests, credential, base } = await fixture();
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(
      await runSessionCommand(['read', `${base}/ask/card.md`], { HYPERNEO_DATA_DIR: dir })
    ).toBe(0);
    expect(output).toHaveBeenCalledWith('# A card\n\nStatus: doing\n');
    expect(requests).toEqual([{ path: '/ask/card.md', auth: `Bearer ${credential}` }]);
  });

  test('never follows a redirect with the credential', async () => {
    const { dir, requests, base } = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await runSessionCommand(['read', `${base}/ask/redirect.md`], { HYPERNEO_DATA_DIR: dir })
    ).toBe(1);
    expect(requests.map((req) => req.path)).toEqual(['/ask/redirect.md']);
  });

  test('refuses sending its credential to a different origin than its daemon', async () => {
    const owner = await fixture();
    const other = await fixture();
    await writeFile(join(owner.dir, 'runtime.json'), JSON.stringify({ url: owner.base }));
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runSessionCommand(['read', `${other.base}/ask/card.md`], {
      HYPERNEO_DATA_DIR: owner.dir,
    });
    expect({ code, requests: other.requests }).toEqual({ code: 1, requests: [] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('origin'));
  });

  test('refuses an unbound credential before making any request', async () => {
    const { dir, requests, credential, base } = await fixture();
    await writeFile(join(dir, 'agent-read.credential'), credential);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await runSessionCommand(['read', `${base}/ask/card.md`], { HYPERNEO_DATA_DIR: dir })
    ).toBe(1);
    expect(requests).toEqual([]);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining(credential));
  });

  test('missing agent credentials never fall back to the human credential', async () => {
    const { dir, requests, base } = await fixture();
    await rm(join(dir, 'agent-read.credential'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await runSessionCommand(['read', `${base}/ask/card.md`], { HYPERNEO_DATA_DIR: dir })
    ).toBe(1);
    expect(requests).toEqual([]);
  });

  test.each([
    'http://localhost/ws',
    'file:///ask/card.md',
    'http://user:secret@localhost/ask/card.md',
    'http://localhost/ask/card.md?key=secret',
  ])('refuses an invalid card link %s', async (link) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runSessionCommand(['read', link], {})).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
