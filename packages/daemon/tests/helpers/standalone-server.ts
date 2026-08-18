const PORT = parseInt(process.env.PORT || '0', 10);

import { createDaemonApp } from '../../src/app';

async function main() {
  const { cleanup, server } = await createDaemonApp({
    config: {
      host: '127.0.0.1',
      port: PORT,
      defaultModel: 'claude-sonnet-4.5-20250929',
      maxTokens: 8192,
      temperature: 1.0,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      claudeCodeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      dbPath: ':memory:',
      maxSessions: 10,
      nodeEnv: 'test',
      workspaceRoot: `${process.env.TMPDIR || '/tmp'}/hyperneo-daemon-test-${Date.now()}`,
      disableWorktrees: true,
    },
    standalone: true,
  });

  process.on('SIGINT', async () => {
    console.error('[DAEMON-SERVER] Received SIGINT, cleaning up...');
    await cleanup();
    console.error('[DAEMON-SERVER] Cleanup complete, exiting...');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('[DAEMON-SERVER] Received SIGTERM, cleaning up...');
    await cleanup();
    console.error('[DAEMON-SERVER] Cleanup complete, exiting...');
    process.exit(0);
  });

  console.error(`[DAEMON-SERVER] Running on port ${server.port}, PID: ${process.pid}`);
}

main().catch((error) => {
  console.error('[DAEMON-SERVER] Fatal error:', error);
  process.exit(1);
});
