import type { Connect, Plugin } from 'vite';
import { resolveNeoEntry } from '../shared/src/web-entry.ts';

export function neoRoutePlugin(): Plugin {
  const route: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const entry = resolveNeoEntry(url);
    if (entry?.kind === 'redirect') {
      res.writeHead(308, { Location: entry.location, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    if (entry?.kind === 'entry') req.url = `${entry.path}${url.search}`;
    next();
  };
  return {
    name: 'neo-clean-url',
    configureServer(server) {
      server.middlewares.use(route);
    },
    configurePreviewServer(server) {
      server.middlewares.use(route);
    },
  };
}
