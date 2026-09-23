export {};

if (process.argv[2] === '--hyperneo-acp-mcp-proxy') {
  const { startAcpMcpProxy } = await import('@hyperneo/daemon/lib/acp/mcp-proxy-entry');
  startAcpMcpProxy(process.argv.slice(3));
} else {
  const [{ parseDaemonArgs, getDaemonHelpText }, { version }] = await Promise.all([
    import('./src/daemon-cli.ts'),
    import('./package.json'),
  ]);

  const { options, error } = parseDaemonArgs(process.argv.slice(2));

  if (error) {
    console.error(`Error: ${error}`);
    if (!options.help) {
      process.exit(1);
    }
  }

  if (options.version) {
    console.log(version);
    process.exit(0);
  }

  if (options.help) {
    console.log(getDaemonHelpText());
    process.exit(0);
  }

  if (options.dataDir) {
    process.env.HYPERNEO_DATA_DIR = options.dataDir;
  }

  process.env.NODE_ENV = 'production';

  const [{ getConfig }, { installProcessFatalLogging }] = await Promise.all([
    import('@hyperneo/daemon/config'),
    import('@hyperneo/daemon/lib/process-fatal-logger'),
  ]);
  installProcessFatalLogging();

  const { dataDir: _dataDir, ...overrides } = options;
  const config = getConfig(overrides);

  console.log(`\n🚀 HyperNeo Daemon`);
  console.log(`   Database: ${config.dbPath}\n`);

  try {
    const { startDaemonServer } = await import('./src/daemon-server.ts');
    await startDaemonServer(config);
  } catch (error) {
    console.error('[Fatal] Daemon startup failed:', error);
    process.exit(1);
  }
}
