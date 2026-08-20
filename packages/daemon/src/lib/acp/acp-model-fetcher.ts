import { AcpClient } from './acp-client';
import { buildAcpSafeEnv, parseAcpCommand } from './acp-command';
import {
  flattenModelChoices,
  type AcpConfiguredModel,
  type AcpProvider,
} from '../providers/acp-provider';

const FETCH_REQUEST_TIMEOUT_MS = 20000;

export const buildAcpDiscoveryEnv = buildAcpSafeEnv;

export async function fetchAcpModels(
  provider: AcpProvider,
  options: { command?: string; cwd?: string } = {}
): Promise<AcpConfiguredModel[]> {
  const commandLine = options.command ?? provider.getAcpCommand();
  if (!commandLine) {
    throw new Error('Set HYPERNEO_ACP_COMMAND to enable ACP agents.');
  }
  const { command, args } = parseAcpCommand(commandLine);
  const workspace = options.cwd ?? process.cwd();
  const client = new AcpClient({
    command,
    args,
    cwd: workspace,
    env: buildAcpDiscoveryEnv(),
    requestTimeoutMs: FETCH_REQUEST_TIMEOUT_MS,
  });
  try {
    await client.initialize();
    await client.authenticate();
    const { configOptions } = await client.createSession(workspace, []);
    const modelOption = configOptions.find((option) => option.category === 'model');
    if (!modelOption) return [];
    return flattenModelChoices(modelOption).map((choice) => ({
      id: choice.value,
      name: choice.name,
    }));
  } finally {
    client.close();
  }
}
