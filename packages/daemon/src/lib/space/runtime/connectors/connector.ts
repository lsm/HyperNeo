export type ConnectorOutcome =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: string;
      retryable?: boolean;
      retryAfterMs?: number;
    };

export interface ConnectorContext {
  workspacePath: string;
  params: Record<string, unknown>;
  rawParams?: Record<string, unknown>;
  hookLocalState: Record<string, unknown>;
}

export type ConnectorOp = (
  opParams: Record<string, unknown>,
  ctx: ConnectorContext
) => Promise<ConnectorOutcome>;

export interface ConnectorAuth {
  readonly envKeys?: readonly string[];
  readonly resolveExtraEnv?: () => Record<string, string | undefined>;
}

export interface Connector {
  readonly id: string;
  readonly ops: Record<string, ConnectorOp>;
  readonly auth?: ConnectorAuth;
}

const connectorRegistry = new Map<string, Connector>();

export function registerConnector(connector: Connector): void {
  connectorRegistry.set(connector.id, connector);
}

export function getConnector(id: string): Connector | undefined {
  return connectorRegistry.get(id);
}

export function isRegisteredConnector(id: string): boolean {
  return connectorRegistry.has(id);
}

export function getRegisteredConnectorIds(): string[] {
  return [...connectorRegistry.keys()];
}

export function clearConnectorRegistry(): void {
  connectorRegistry.clear();
}

export function isConnectorsLayerEnabled(): boolean {
  return process.env.HYPERNEO_WORKFLOW_CONNECTORS !== '0';
}
