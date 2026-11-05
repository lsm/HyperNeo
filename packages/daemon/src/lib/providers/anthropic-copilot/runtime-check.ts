import { resolveCopilotRuntime } from './copilot-cli-resolver.ts';
import { startCopilotClient } from './copilot-client.ts';

export async function runCopilotRuntimeCheck(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { path, source } = await resolveCopilotRuntime(env);
  const client = await startCopilotClient(env);
  const { version } = await client.getStatus();
  await client.stop();
  // oxlint-disable-next-line no-console
  console.log(JSON.stringify({ path, source, version }));
}
