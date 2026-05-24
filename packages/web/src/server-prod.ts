import { serve } from 'bun';

const DAEMON_URL = process.env.DAEMON_URL || 'http://localhost:8283';
const PORT = process.env.PORT || 9283;

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // API proxy to daemon
    if (url.pathname.startsWith('/api/')) {
      const daemonUrl = `${DAEMON_URL}${url.pathname}${url.search}`;

      try {
        const response = await fetch(daemonUrl, {
          method: req.method,
          headers: req.headers,
          ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req.body } : {}),
        });

        return response;
      } catch {
        // Proxy error - return error response to client
        return new Response(JSON.stringify({ error: 'Failed to connect to daemon' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Serve static files from dist/
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(`./dist${path}`);

    if (await file.exists()) {
      return new Response(file);
    }

    // SPA fallback - serve index.html for unmatched routes
    return new Response(Bun.file('./dist/index.html'));
  },
});
