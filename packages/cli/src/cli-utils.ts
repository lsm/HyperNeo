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
      options.help = true;
      return { options, error: `Unknown option: ${arg}` };
    }
  }

  return { options };
}

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

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

export function createCorsPreflightResponse(): Response {
  return new Response(null, { headers: CORS_HEADERS });
}

export function shouldHaveImmutableCache(path: string): boolean {
  return /\.(js|css|woff2?|ttf|svg|png|jpg|jpeg|gif|ico)$/.test(path);
}

export function isHtmlFile(path: string): boolean {
  return path.endsWith('.html');
}

export function getCacheControlHeader(path: string): string {
  if (shouldHaveImmutableCache(path)) {
    return 'public, max-age=31536000, immutable';
  }
  if (isHtmlFile(path)) {
    return 'no-cache';
  }
  return 'public, max-age=3600';
}

export function isWebSocketPath(pathname: string): boolean {
  return pathname === '/ws';
}

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

function getNetworkAddresses(): Array<{ label: string; address: string }> {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const addresses: Array<{ label: string; address: string }> = [];

  for (const [name, nets] of Object.entries(interfaces)) {
    if (!nets) continue;
    for (const net of nets as Array<{ family: string; address: string; internal: boolean }>) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ label: name, address: net.address });
      }
    }
  }

  return addresses;
}

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

export async function findAvailablePort(): Promise<number> {
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
