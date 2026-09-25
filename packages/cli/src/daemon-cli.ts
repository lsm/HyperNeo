export interface DaemonOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  dataDir?: string;
  workspaceRoot?: string;
  help?: boolean;
  version?: boolean;
}

export interface ParseDaemonArgsResult {
  options: DaemonOptions;
  error?: string;
}

export function parseDaemonArgs(args: string[]): ParseDaemonArgsResult {
  const options: DaemonOptions = {};

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
    } else if (arg === '--data-dir') {
      options.dataDir = args[++i];
      if (!options.dataDir) {
        return { options, error: '--data-dir requires a directory' };
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

export function getDaemonHelpText(): string {
  return `
HyperNeo Daemon - standalone daemon binary without the web UI

Usage: hyperneod [options]

Options:
  -p, --port <port>         Port to listen on (default: 9283)
  --host <host>             Host to bind to (default: 0.0.0.0)
  --db-path <path>          Database file path (default: <data-dir>/data/daemon.db)
  --data-dir <dir>          Data directory for daemon state (default: ~/.hyperneo)
  --workspace <path>        Default workspace root for file indexing
  -V, --version             Show version number
  -h, --help                Show this help message

Examples:
  hyperneod                            Start daemon (state under ~/.hyperneo)
  hyperneod -p 9400                    Start on port 9400
  hyperneod --data-dir /var/lib/hyperneod   Keep all daemon state under /var/lib/hyperneod
  hyperneod --db-path /data/daemon.db  Use a custom database path
`;
}
