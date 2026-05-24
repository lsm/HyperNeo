/**
 * Production entry point for compiled binary.
 * Does NOT import dev-server.ts or Vite — only production code.
 */

import { getConfig } from '@neokai/daemon/config';
import { parseArgs, getHelpText } from './src/cli-utils';
import { startProdServer } from './src/prod-server-embedded';
import { version } from './package.json';

// The SDK CLI binary is no longer embedded in the compiled binary.
// Instead, the runtime resolver (sdk-cli-resolver.ts) downloads it
// on first use and caches it at ~/.neokai/sdk/. This keeps the
// compiled binary ~66 MB instead of ~266 MB.

// Handle uncaught errors to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Fatal] Unhandled Promise Rejection:', reason);
  console.error('Promise:', promise);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[Fatal] Uncaught Exception:', error);
  process.exit(1);
});

const { options: cliOptions, error } = parseArgs(process.argv.slice(2));

if (error) {
  console.error(`Error: ${error}`);
  if (!cliOptions.help) {
    process.exit(1);
  }
}

if (cliOptions.version) {
  console.log(version);
  process.exit(0);
}

if (cliOptions.help) {
  console.log(getHelpText());
  process.exit(0);
}

// Production binary always runs in production mode
process.env.NODE_ENV = 'production';

const config = getConfig(cliOptions);

console.log(`\nNeoKai Server`);
console.log(`   Database: ${config.dbPath}\n`);

try {
  await startProdServer(config);
} catch (error) {
  console.error('[Fatal] Server startup failed:', error);
  process.exit(1);
}
