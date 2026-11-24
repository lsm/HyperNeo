import { generateUUID, type Session } from '@hyperneo/shared';
import type { SDKSystemMessage } from '@hyperneo/shared/sdk';
import type { OxapInitDetails } from '@hyperneo/shared/types/oxap-harnesses';
import type { OxapHubClient } from './oxap-hub-client.ts';
import type { savedOxapAdapter } from './oxap-hub-config.ts';
import { OXAP_VERSION } from './oxap-install.ts';
import { publishOxapMessage } from './oxap-notice.ts';
import {
  sessionHarness,
  type OxapOpenPlan,
  type OxapReopenEvents,
  type OxapReopenStore,
} from './oxap-reopen.ts';

type Source = { id: string; kind: string; display_name?: string };
type State = { current_model_id?: string; sources?: Source[] };
type Capabilities = {
  endpoint?: { name?: string };
  features?: Record<string, { level?: string }>;
};
type ToolCatalog = { tools?: { name: string }[]; sources?: Source[] };
type ModelCatalog = { models?: { id: string; context_window?: number }[] };

async function readPayload<T>(
  client: OxapHubClient,
  operation: string,
  input: Record<string, string>
): Promise<T | undefined> {
  const response = await client.request(operation, input).catch(() => undefined);
  return (response as { payload?: T } | undefined)?.payload;
}

export async function recordOxapInit(
  client: OxapHubClient,
  plan: OxapOpenPlan,
  session: Session,
  adapter: ReturnType<typeof savedOxapAdapter> | null,
  eventPayload: unknown,
  db: OxapReopenStore,
  hub: OxapReopenEvents,
  ensureLive: () => void
): Promise<void> {
  const scope = { session_id: session.id };
  const [capabilities, state] = await Promise.all([
    readPayload<Capabilities>(client, 'capabilities', { adapter: String(plan.request.adapter) }),
    readPayload<State>(client, 'state', scope),
  ]);
  const supports = (feature: string) =>
    ['native', 'emulated'].includes(capabilities?.features?.[feature]?.level ?? '');
  const [tools, models] = await Promise.all([
    supports('action.tools.list') ? readPayload<ToolCatalog>(client, 'tools', scope) : undefined,
    supports('models.list') ? readPayload<ModelCatalog>(client, 'models', scope) : undefined,
  ]);
  const runModel = (eventPayload as { model_id?: unknown } | undefined)?.model_id;
  const model = (typeof runModel === 'string' && runModel) || state?.current_model_id;
  const contextWindow = models?.models?.find(({ id }) => id === model)?.context_window;
  const settings = adapter?.row.entry(adapter.settings, []);
  const permissionMode =
    typeof settings?.approval_policy === 'string' ? settings.approval_policy : undefined;
  const oxap: OxapInitDetails = {
    client: capabilities?.endpoint?.name || sessionHarness(session).label,
    version: OXAP_VERSION,
    contextWindow,
  };
  const mcpServers = (tools?.sources ?? state?.sources)?.filter(({ kind }) => kind === 'mcp');
  const message = {
    type: 'system',
    subtype: 'init',
    uuid: generateUUID(),
    session_id: session.sdkSessionId,
    cwd: plan.directory,
    model,
    permissionMode,
    oxap,
    tools: tools?.tools?.map(({ name }) => name),
    mcp_servers: mcpServers?.map(({ id, display_name }) => ({ name: display_name || id })),
  } as unknown as SDKSystemMessage;
  await publishOxapMessage(session.id, message, db, hub, ensureLive);
}
