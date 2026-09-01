export type DaemonConfigKeyType = 'int' | 'boolean';

export type DaemonConfigAppliesAt = 'live' | 'restart';

export type DaemonConfigFamily =
  | 'deliveryTiming'
  | 'deliveryPolicy'
  | 'sdkAcp'
  | 'providersMisc'
  | 'spaceEvents'
  | 'startup'
  | 'flags';

export interface DaemonConfigKeyEntry {
  key: string;
  family: DaemonConfigFamily;
  type: DaemonConfigKeyType;
  default: number | boolean;
  min?: number;
  max?: number;
  appliesAt: DaemonConfigAppliesAt;
  description: string;
  legacyEnvName: string;
}

export interface DaemonBehaviorConfig {
  deliveryTiming?: {
    deliveryConsumptionTimeoutMs?: number;
    deliveryCoordinationAcquireTimeoutMs?: number;
    operationLockAcquireTimeoutMs?: number;
    operationLockLeakCeilingMs?: number;
    interruptControlTimeoutMs?: number;
  };
  deliveryPolicy?: {
    messageDeliveryMaxRetries?: number;
    messageDeliveryMaxConcurrent?: number;
    jobQueueMaxConcurrent?: number;
  };
  sdkAcp?: {
    sdkStartupMaxConcurrent?: number;
    sdkStartInactivityTimeoutMs?: number;
    acpMcpProxyCallTimeoutMs?: number;
    acpContextWindow?: number;
  };
  providersMisc?: {
    providerMaxRetries?: number;
    providerRetryBaseDelayMs?: number;
    taskNotificationRequeryBaseDelayMs?: number;
    fileIndexPollMs?: number;
    spaceActionsRateLimitPerMinute?: number;
  };
  spaceEvents?: {
    externalEventDigestIdleDebounceMs?: number;
    externalEventDigestCountCap?: number;
    externalEventDigestSafetyMs?: number;
    externalEventRenderDrainMs?: number;
  };
  startup?: {
    maxSubscriptionsPerClient?: number;
    disableWorktrees?: boolean;
    disableGoalProcessing?: boolean;
    logMaxBytes?: number;
    logRetainedFiles?: number;
    logMaxPendingBytes?: number;
    sqlQueryObservability?: boolean;
    sqlQuerySlowThresholdMs?: number;
    sqlQuerySummaryIntervalMs?: number;
    sqlQueryMaxQueryGroups?: number;
    sqlQuerySummaryLimit?: number;
  };
  flags?: {
    spaceActionsDispatcher?: boolean;
    workflowConnectors?: boolean;
    taskAgentPostApprovalRouting?: boolean;
  };
}

type FamilyRows = {
  [F in DaemonConfigFamily]-?: {
    [K in keyof NonNullable<DaemonBehaviorConfig[F]>]-?: readonly [number | boolean, string];
  };
};

const FAMILY_ROWS: FamilyRows = {
  deliveryTiming: {
    deliveryConsumptionTimeoutMs: [30_000, 'ms to wait for SDK consumption of a delivery'],
    deliveryCoordinationAcquireTimeoutMs: [8_000, 'timeout to acquire delivery coordination'],
    operationLockAcquireTimeoutMs: [8_000, 'timeout acquiring the session operation lock'],
    operationLockLeakCeilingMs: [900_000, 'age at which a held operation lock counts as leaked'],
    interruptControlTimeoutMs: [2_000, 'timeout for the interrupt control handshake'],
  },
  deliveryPolicy: {
    messageDeliveryMaxRetries: [8, 'max delivery attempts before failing a turn'],
    messageDeliveryMaxConcurrent: [64, 'max concurrently settled message deliveries'],
    jobQueueMaxConcurrent: [5, 'max concurrently running background jobs'],
  },
  sdkAcp: {
    sdkStartupMaxConcurrent: [3, 'max concurrent SDK subprocess startups'],
    sdkStartInactivityTimeoutMs: [600_000, 'inactivity backstop while awaiting SDK start'],
    acpMcpProxyCallTimeoutMs: [60_000, 'per-call timeout for proxied ACP MCP tools'],
    acpContextWindow: [200_000, 'context window size reported for ACP agents'],
  },
  providersMisc: {
    providerMaxRetries: [3, 'max retries for failed provider queries'],
    providerRetryBaseDelayMs: [2_000, 'base delay for provider retry backoff'],
    taskNotificationRequeryBaseDelayMs: [500, 'base delay for task-notification requery backoff'],
    fileIndexPollMs: [60_000, 'poll interval for the workspace file index'],
    spaceActionsRateLimitPerMinute: [0, 'space-actions dispatches per minute; 0 disables'],
  },
  spaceEvents: {
    externalEventDigestIdleDebounceMs: [30_000, 'idle debounce before digest pulls'],
    externalEventDigestCountCap: [50, 'pending event count that forces a digest pull'],
    externalEventDigestSafetyMs: [300_000, 'safety timer that forces a digest pull'],
    externalEventRenderDrainMs: [30_000, 'shutdown drain window for pending digest renders'],
  },
  startup: {
    maxSubscriptionsPerClient: [128, 'max MessageHub subscriptions per client'],
    disableWorktrees: [false, 'disable worktree session isolation'],
    disableGoalProcessing: [false, 'disable Space goal processing'],
    logMaxBytes: [10_485_760, 'max size of one structured log file'],
    logRetainedFiles: [5, 'retained structured log files before rotation'],
    logMaxPendingBytes: [2_097_152, 'max in-memory bytes for pending log writes'],
    sqlQueryObservability: [true, 'enable SQL query observability logging'],
    sqlQuerySlowThresholdMs: [250, 'slow-query threshold for SQL observability'],
    sqlQuerySummaryIntervalMs: [300_000, 'interval for SQL query summary logs'],
    sqlQueryMaxQueryGroups: [500, 'max tracked query groups in SQL summaries'],
    sqlQuerySummaryLimit: [10, 'row limit for SQL query summary logs'],
  },
  flags: {
    spaceActionsDispatcher: [true, 'enable the space-actions dispatcher server'],
    workflowConnectors: [true, 'enable workflow runtime connectors'],
    taskAgentPostApprovalRouting: [true, 'enable post-approval routing to sub-sessions'],
  },
};

const RESTART_FAMILIES = new Set<DaemonConfigFamily>(['startup', 'flags']);

const APPLIES_AT_RESTART = new Set(['messageDeliveryMaxConcurrent', 'jobQueueMaxConcurrent']);

const RANGE_OVERRIDES: Record<string, { min?: number; max?: number }> = {
  providerMaxRetries: { min: 0 },
  providerRetryBaseDelayMs: { min: 0 },
  taskNotificationRequeryBaseDelayMs: { min: 0 },
  spaceActionsRateLimitPerMinute: { min: 0 },
  logRetainedFiles: { max: 1000 },
};

function legacyEnvNameFor(key: string): string {
  return `HYPERNEO_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/** @public */
export const DAEMON_CONFIG_KEY_CATALOG: readonly DaemonConfigKeyEntry[] = Object.entries(
  FAMILY_ROWS
).flatMap(([family, rows]) =>
  Object.entries(rows).map(([key, [defaultValue, description]]) => {
    const type: DaemonConfigKeyType = typeof defaultValue === 'boolean' ? 'boolean' : 'int';
    const range = RANGE_OVERRIDES[key];
    const min = range?.min ?? (type === 'int' ? 1 : undefined);
    const max = range?.max;
    const isRestart =
      APPLIES_AT_RESTART.has(key) || RESTART_FAMILIES.has(family as DaemonConfigFamily);
    return {
      key,
      family: family as DaemonConfigFamily,
      type,
      default: defaultValue,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      appliesAt: isRestart ? 'restart' : 'live',
      description,
      legacyEnvName: legacyEnvNameFor(key),
    } satisfies DaemonConfigKeyEntry;
  })
);

function resolveIntValue(raw: unknown, entry: DaemonConfigKeyEntry): number {
  let parsed: number;
  if (typeof raw === 'number') parsed = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') parsed = Number(raw);
  else return entry.default as number;
  if (!Number.isFinite(parsed)) return entry.default as number;
  let value = Math.trunc(parsed);
  if (value <= 0 && (entry.min ?? 0) > 0) return entry.default as number;
  if (entry.min !== undefined && value < entry.min) value = entry.min;
  if (entry.max !== undefined && value > entry.max) value = entry.max;
  return value;
}

function resolveBooleanValue(raw: unknown, entry: DaemonConfigKeyEntry): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 1) return true;
  if (raw === 0) return false;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return entry.default as boolean;
}

/** @public */
export function resolveDaemonConfig(
  stored: Partial<DaemonBehaviorConfig> | undefined
): DaemonBehaviorConfig {
  const resolved: DaemonBehaviorConfig = {};
  for (const entry of DAEMON_CONFIG_KEY_CATALOG) {
    const familyStored = stored?.[entry.family] as Record<string, unknown> | undefined;
    const raw = familyStored?.[entry.key];
    const value =
      entry.type === 'boolean' ? resolveBooleanValue(raw, entry) : resolveIntValue(raw, entry);
    const familyConfig = (resolved[entry.family] ??= {}) as Record<string, number | boolean>;
    familyConfig[entry.key] = value;
  }
  return resolved;
}

/** @public */
export const DEFAULT_DAEMON_CONFIG: DaemonBehaviorConfig = resolveDaemonConfig(undefined);
