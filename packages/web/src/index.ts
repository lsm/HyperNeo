import { serve } from 'bun';
import index from './index.html';

const DAEMON_URL = process.env.DAEMON_URL || 'http://localhost:8283';
const PORT = process.env.PORT || 9283;
const isDev = process.env.NODE_ENV !== 'production';

const _server = serve({
  port: PORT,

  async fetch(req: Request, _server: unknown) {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      const daemonUrl = `${DAEMON_URL}${url.pathname}${url.search}`;

      try {
        const fetchOptions: RequestInit = {
          method: req.method,
          headers: req.headers,
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          fetchOptions.body = req.body;
        }

        const response = await fetch(daemonUrl, fetchOptions);

        return response;
      } catch (error) {
        console.error('API proxy error:', error);
        return new Response(JSON.stringify({ error: 'Failed to connect to daemon' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return null as unknown as Response;
  },

  routes: {
    '/*': index,
  },

  development: isDev && {
    hmr: true,
    console: true,
  },
});
