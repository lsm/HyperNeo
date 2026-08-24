export {};

if (process.argv[2] === '--hyperneo-acp-mcp-proxy') {
  const { startAcpMcpProxy } = await import('@hyperneo/daemon/lib/acp/mcp-proxy-entry');
  startAcpMcpProxy(process.argv.slice(3));
} else {
  const [{ getConfig }, { parseArgs, getHelpText }, { startProdServer }, { version }] =
    await Promise.all([
      import('@hyperneo/daemon/config'),
      import('./src/cli-utils.ts'),
      import('./src/prod-server-embedded.ts'),
      import('./package.json'),
    ]);

  const { installProcessFatalLogging } = await import('@hyperneo/daemon/lib/process-fatal-logger');
  installProcessFatalLogging();

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

  process.env.NODE_ENV = 'production';

  const config = getConfig(cliOptions);

  console.log(`\n🚀 HyperNeo Production Server`);
  console.log(`   Database: ${config.dbPath}\n`);

  try {
    await startProdServer(config);
  } catch (error) {
    console.error('[Fatal] Server startup failed:', error);
    process.exit(1);
  }
}
