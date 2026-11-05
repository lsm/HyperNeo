import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import { resolveCopilotRuntime } from './copilot-cli-resolver.ts';

export async function startCopilotClient(
  env: NodeJS.ProcessEnv,
  waitMs?: number
): Promise<CopilotClient> {
  const { path } = await resolveCopilotRuntime(env, waitMs);
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path }),
    logLevel: 'error',
    env,
  });
  await client.start();
  return client;
}
