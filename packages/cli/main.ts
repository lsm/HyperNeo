#!/usr/bin/env bun
import { getConfig } from '@neokai/daemon/config';
import { parseArgs, getHelpText } from './src/cli-utils';

// Parse CLI arguments
const { options: cliOptions, error } = parseArgs(process.argv.slice(2));

if (error) {
  console.error(`Error: ${error}`);
  if (!cliOptions.help) {
    process.exit(1);
  }
}

if (cliOptions.version) {
  const pkg = await import('./package.json');
  console.log(pkg.version);
  process.exit(0);
}

if (cliOptions.help) {
  console.log(getHelpText());
  process.exit(0);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isDev = nodeEnv === 'development';
const isTest = nodeEnv === 'test';

const config = getConfig(cliOptions);

const serverMode = isDev ? 'Development' : isTest ? 'Test' : 'Production';
console.log(`\n🚀 NeoKai ${serverMode} Server`);
console.log(`   Mode: ${config.nodeEnv}`);
console.log(`   Model: ${config.defaultModel}`);
console.log(`   Database: ${config.dbPath}\n`);

if (isDev) {
  // Development mode: Vite dev server + Daemon (for local development with HMR)
  const { startDevServer } = await import('./src/dev-server');
  await startDevServer(config);
} else {
  // Production/Test mode: Static files + Daemon (production-like, no HMR)
  const { startProdServer } = await import('./src/prod-server');
  await startProdServer(config);
}
