const [door, port, dbPath] = process.argv.slice(2);
if (process.env.NODE_ENV !== 'test' || port === '8399') throw new Error('test daemons only');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const config = getConfig({ port: Number(port), host: '127.0.0.1', dbPath });
const start = {
  daemon: async () => (await import('../../../packages/cli/src/daemon-server.ts')).startDaemonServer,
  prod: async () => (await import('../../../packages/cli/src/prod-server.ts')).startProdServer,
  dev: async () => (await import('../../../packages/cli/src/dev-server.ts')).startDevServer,
  embedded: async () =>
    (await import('../../../packages/cli/src/prod-server-embedded.ts')).startProdServer,
}[door as 'daemon' | 'prod' | 'dev' | 'embedded'];
if (!start) throw new Error(`unknown front door ${door}`);
await (await start())(config);
