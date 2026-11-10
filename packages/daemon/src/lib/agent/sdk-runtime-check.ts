import { execFileSync } from 'node:child_process';
import { resolveCopilotRuntime } from '../providers/anthropic-copilot/copilot-cli-resolver.ts';
import { startCopilotClient } from '../providers/anthropic-copilot/copilot-client.ts';
import { warmupSDKCliBinary } from './sdk-cli-resolver.ts';

async function checkClaude() {
  const { status, path, source, error } = await warmupSDKCliBinary();
  if (status !== 'ready' || !path) throw new Error(`Claude Code binary unavailable: ${error}`);
  const version = execFileSync(path, ['--version'], { encoding: 'utf8' }).trim();
  return { path, source, version };
}

async function checkCopilot(env: NodeJS.ProcessEnv) {
  const { path, source } = await resolveCopilotRuntime(env);
  const client = await startCopilotClient(env);
  const { version } = await client.getStatus();
  await client.stop();
  return { path, source, version };
}

export async function runSdkRuntimeCheck(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const claude = await checkClaude();
  const copilot = await checkCopilot(env);
  // oxlint-disable-next-line no-console
  console.log(JSON.stringify({ claude, copilot }));
}
