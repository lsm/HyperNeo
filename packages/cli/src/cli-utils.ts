/**
 * CLI argument parsing utilities
 * Extracted from main.ts for testability
 */

export interface CliOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  workspaceRoot?: string;
  help?: boolean;
  version?: boolean;
}

export interface ParseArgsResult {
  options: CliOptions;
  error?: string;
}

/**
 * Parse CLI arguments into options
 * Returns an error message instead of exiting for testability
 */
export function parseArgs(args: string[]): ParseArgsResult {
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-V') {
      options.version = true;
    } else if (arg === '--port' || arg === '-p') {
      const portValue = args[++i];
      if (portValue && !isNaN(Number(portValue))) {
        options.port = parseInt(portValue, 10);
      } else {
        return { options, error: `Invalid port value: ${portValue}` };
      }
    } else if (arg === '--host') {
      options.host = args[++i];
      if (!options.host) {
        return { options, error: '--host requires a value' };
      }
    } else if (arg === '--db-path') {
      options.dbPath = args[++i];
      if (!options.dbPath) {
        return { options, error: '--db-path requires a path' };
      }
    } else if (arg === '--workspace') {
      options.workspaceRoot = args[++i];
      if (!options.workspaceRoot) {
        return { options, error: '--workspace requires a path' };
      }
    } else {
      // Unknown option - set help flag and return error
      options.help = true;
      return { options, error: `Unknown option: ${arg}` };
    }
  }

  return { options };
}

/**
 * Get the help text for the CLI
 */
export function getHelpText(): string {
  return `
HyperNeo - Claude Code web UI for coding, life, and anything in between

Usage: hyperneo [options]

Options:
  -p, --port <port>         Port to listen on (default: 9283)
  --host <host>             Host to bind to (default: 0.0.0.0)
  --db-path <path>          Database file path (default: ~/.hyperneo/data/daemon.db)
  --workspace <path>        Default workspace root for file indexing
  -V, --version             Show version number
  -h, --help                Show this help message

Examples:
  hyperneo                      Start server (database at ~/.hyperneo/data/daemon.db)
  hyperneo -p 8080              Start on port 8080
  hyperneo --workspace ~/code   Start with a default workspace root
  hyperneo --db-path /data/db.db  Use a custom database path
`;
}

// ============================================================
// Server Utilities
// ============================================================

/**
 * CORS headers for preflight responses
 */
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

/**
 * Create a CORS preflight response
 */
export function createCorsPreflightResponse(): Response {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * Check if a file extension should have immutable cache headers
 * These are typically content-hashed assets
 */
export function shouldHaveImmutableCache(path: string): boolean {
  return /\.(js|css|woff2?|ttf|svg|png|jpg|jpeg|gif|ico)$/.test(path);
}

/**
 * Check if a path is an HTML file that should not be cached
 */
export function isHtmlFile(path: string): boolean {
  return path.endsWith('.html');
}

/**
 * Get appropriate cache control header for a static file
 */
export function getCacheControlHeader(path: string): string {
  if (shouldHaveImmutableCache(path)) {
    return 'public, max-age=31536000, immutable';
  }
  if (isHtmlFile(path)) {
    return 'no-cache';
  }
  // Default: short cache
  return 'public, max-age=3600';
}

/**
 * Check if a request path is the WebSocket endpoint
 */
export function isWebSocketPath(pathname: string): boolean {
  return pathname === '/ws';
}

/**
 * Create a JSON error response
 */
export function createJsonErrorResponse(message: string, status: number = 500): Response {
  return new Response(
    JSON.stringify({
      error: status >= 500 ? 'Internal server error' : 'Error',
      message,
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Get local network addresses for display
 * Returns an array of { label, address } for all non-internal IPv4 interfaces
 */
function getNetworkAddresses(): Array<{ label: string; address: string }> {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const addresses: Array<{ label: string; address: string }> = [];

  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) continue;
    for (const net of nets as Array<{ family: string; address: string; internal: boolean }>) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ label: name, address: net.address });
      }
    }
  }

  return addresses;
}

/**
 * Print server listening info with all network addresses
 */
export function printServerUrls(port: number, host: string): void {
  console.log(`   🌐 Local:   http://localhost:${port}`);

  if (host === '0.0.0.0' || host === '::') {
    const addresses = getNetworkAddresses();
    for (const { label, address } of addresses) {
      console.log(`   🌐 Network: http://${address}:${port}  (${label})`);
    }
  } else if (host !== 'localhost' && host !== '127.0.0.1') {
    console.log(`   🌐 Network: http://${host}:${port}`);
  }

  console.log(`   🔌 WebSocket: ws://localhost:${port}/ws`);
}

/**
 * Find an available port by creating a temporary server
 * Uses Node.js net module to bind to port 0 (OS assigns available port)
 */
export async function findAvailablePort(): Promise<number> {
  // Import net dynamically to avoid issues in browser builds
  const net = await import('net');

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
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
