import { existsSync, statSync } from 'node:fs';

export function resolveCopilotCliPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envPath = env.COPILOT_CLI_PATH;
  if (envPath && existsSync(envPath)) {
    try {
      const stat = statSync(envPath);
      if (stat.isFile() && stat.size > 0) {
        return envPath;
      }
    } catch {}
  }
  return undefined;
}
