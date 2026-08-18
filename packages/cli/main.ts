#!/usr/bin/env bun
export {};

if (process.argv[2] === '--hyperneo-acp-mcp-proxy') {
  const { startAcpMcpProxy } = await import('@hyperneo/daemon/lib/acp/mcp-proxy-entry');
  startAcpMcpProxy(process.argv.slice(3));
} else {
  const [{ getConfig }, { parseArgs, getHelpText }] = await Promise.all([
    import('@hyperneo/daemon/config'),
    import('./src/cli-utils'),
  ]);
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
  console.log(`\n🚀 HyperNeo ${serverMode} Server`);
  console.log(`   Mode: ${config.nodeEnv}`);
  console.log(`   Model: ${config.defaultModel}`);
  console.log(`   Database: ${config.dbPath}\n`);

  if (isDev) {
    const { startDevServer } = await import('./src/dev-server');
    await startDevServer(config);
  } else {
    const { startProdServer } = await import('./src/prod-server');
    await startProdServer(config);
  }
}
