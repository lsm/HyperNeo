import { serve } from 'bun';
import index from './index.html';

const DAEMON_URL = process.env.DAEMON_URL || 'http://localhost:8283';
const PORT = process.env.PORT || 9283;
const isDev = process.env.NODE_ENV !== 'production';

const _server = serve({
  port: PORT,

  async fetch(req: Request, _server: unknown) {
    const url = new URL(req.url);

    // API proxy to daemon - forward all /api requests
    if (url.pathname.startsWith('/api/')) {
      const daemonUrl = `${DAEMON_URL}${url.pathname}${url.search}`;

      try {
        const fetchOptions: RequestInit = {
          method: req.method,
          headers: req.headers,
        };

        // Only include body for non-GET/HEAD requests
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

    // Let Bun's development server handle static files (JS, CSS, etc.)
    // This is important for proper MIME types and module serving
    return null as unknown as Response;
  },

  routes: {
    // SPA - serve index.html for all routes (client-side handling)
    '/*': index,
  },

  development: isDev && {
    hmr: true, // Hot module replacement
    console: true, // Stream browser console to terminal
  },
});
