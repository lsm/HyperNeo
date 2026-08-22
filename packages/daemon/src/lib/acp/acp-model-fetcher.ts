import { AcpClient } from './acp-client';
import { buildAcpSafeEnv, parseAcpCommand } from './acp-command';
import { type AcpProcessTreeOwner, getAcpProcessTreeOwner } from './acp-process-tree';
import {
  flattenModelChoices,
  type AcpConfiguredModel,
  type AcpProvider,
} from '../providers/acp-provider';

const FETCH_REQUEST_TIMEOUT_MS = 20000;
const FETCH_OVERALL_TIMEOUT_MS = 9000;

export const buildAcpDiscoveryEnv = buildAcpSafeEnv;

export async function disposeAcpSessions(
  commandLine: string,
  sessionIds: string[],
  processTreeOwner?: AcpProcessTreeOwner,
  signal?: AbortSignal
): Promise<void> {
  if (sessionIds.length === 0) return;
  if (signal?.aborted) return;
  const { command, args } = parseAcpCommand(commandLine);
  const workspace = process.cwd();
  const owner = processTreeOwner ?? (await getAcpProcessTreeOwner());
  if (signal?.aborted) return;
  const client = new AcpClient({
    command,
    args,
    cwd: workspace,
    requestTimeoutMs: FETCH_REQUEST_TIMEOUT_MS,
    processTreeOwner: owner,
  });
  const abortDispose = () => {
    void client.close();
  };
  signal?.addEventListener('abort', abortDispose, { once: true });
  try {
    await client.initialize();
    await client.authenticate();
    if (!client.canCloseSession()) return;
    await Promise.allSettled(sessionIds.map((id) => client.closeSession(id)));
  } finally {
    signal?.removeEventListener('abort', abortDispose);
    await client.close();
  }
}

export async function fetchAcpModels(
  provider: AcpProvider,
  options: { command?: string; cwd?: string; overallTimeoutMs?: number } = {}
): Promise<AcpConfiguredModel[]> {
  const commandLine = options.command ?? provider.getAcpCommand();
  if (!commandLine) {
    throw new Error('Set HYPERNEO_ACP_COMMAND to enable ACP agents.');
  }
  const { command, args } = parseAcpCommand(commandLine);
  const workspace = options.cwd ?? process.cwd();
  const overallTimeoutMs = options.overallTimeoutMs ?? FETCH_OVERALL_TIMEOUT_MS;
  const processTreeOwner = await getAcpProcessTreeOwner();
  const client = new AcpClient({
    command,
    args,
    cwd: workspace,
    env: buildAcpDiscoveryEnv(),
    replaceEnv: true,
    requestTimeoutMs: FETCH_REQUEST_TIMEOUT_MS,
    processTreeOwner,
  });
  let timeoutReject: ((reason: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutReject = reject;
  });
  const overallTimer = setTimeout(() => {
    timeoutReject?.(new Error(`ACP model discovery timed out after ${overallTimeoutMs}ms`));
    void client.close();
  }, overallTimeoutMs);
  overallTimer.unref();
  try {
    return await Promise.race([discoverAcpModels(client, workspace), timeoutPromise]);
  } finally {
    clearTimeout(overallTimer);
  }
}

async function discoverAcpModels(
  client: AcpClient,
  workspace: string
): Promise<AcpConfiguredModel[]> {
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
    if (client.canCloseSession()) {
      await client.closeSession().catch(() => {});
    }
    await client.close();
  }
}
