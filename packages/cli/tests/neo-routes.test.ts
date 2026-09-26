import { afterEach, describe, expect, test } from 'vitest';
import { createServer, preview } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { neoRoutePlugin } from '../../web/neo-route-plugin.ts';

describe('Neo clean URLs', () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  test.each(['development', 'preview'] as const)(
    '%s serves Neo, preserves old bookmarks, and leaves the main app alone',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'neo-routes-'));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      await mkdir(join(root, 'neo'));
      await writeFile(join(root, 'index.html'), '<html><body>Main app</body></html>');
      await writeFile(join(root, 'neo/index.html'), '<html><body>Neo app</body></html>');
      const config = {
        configFile: false as const,
        root,
        plugins: [neoRoutePlugin()],
        server: { host: '127.0.0.1', port: 0 },
        preview: { host: '127.0.0.1', port: 0 },
        build: { outDir: root },
      };
      let port: number;
      if (mode === 'development') {
        const server = await createServer(config);
        cleanup.push(() => server.close());
        await server.listen();
        const address = server.httpServer!.address();
        if (!address || typeof address === 'string') throw new Error('No HTTP port');
        port = address.port;
      } else {
        const server = await preview(config);
        cleanup.push(
          () =>
            new Promise<void>((resolve, reject) => {
              server.httpServer.close((error) => (error ? reject(error) : resolve()));
            })
        );
        const address = server.httpServer.address();
        if (!address || typeof address === 'string') throw new Error('No HTTP port');
        port = address.port;
      }
      const base = `http://127.0.0.1:${port}`;
      for (const path of ['/neo', '/neo?examples']) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(200);
        expect(response.url).toBe(`${base}${path}`);
        expect(await response.text()).toContain('Neo app');
      }
      for (const path of ['/neo/', '/neo/index.html']) {
        const response = await fetch(`${base}${path}?examples&x=a%20b`, { redirect: 'manual' });
        expect(response.status).toBe(308);
        expect(response.headers.get('location')).toBe('/neo?examples&x=a%20b');
      }
      expect(await (await fetch(`${base}/spaces`)).text()).toContain('Main app');
    }
  );
});
