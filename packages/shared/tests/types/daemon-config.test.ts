import { describe, expect, it } from 'bun:test';
import {
  DAEMON_CONFIG_KEY_CATALOG,
  DEFAULT_DAEMON_CONFIG,
  resolveDaemonConfig,
  type DaemonConfigKeyEntry,
} from '../../src/types/daemon-config.ts';

const EXPECTED_ENV_BY_FAMILY: Record<string, string[]> = {
  deliveryTiming: [
    'HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS',
    'HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS',
    'HYPERNEO_OPERATION_LOCK_ACQUIRE_TIMEOUT_MS',
    'HYPERNEO_OPERATION_LOCK_LEAK_CEILING_MS',
    'HYPERNEO_INTERRUPT_CONTROL_TIMEOUT_MS',
  ],
  deliveryPolicy: [
    'HYPERNEO_MESSAGE_DELIVERY_MAX_RETRIES',
    'HYPERNEO_MESSAGE_DELIVERY_MAX_CONCURRENT',
    'HYPERNEO_JOB_QUEUE_MAX_CONCURRENT',
  ],
  sdkAcp: [
    'HYPERNEO_SDK_STARTUP_MAX_CONCURRENT',
    'HYPERNEO_SDK_START_INACTIVITY_TIMEOUT_MS',
    'HYPERNEO_ACP_MCP_PROXY_CALL_TIMEOUT_MS',
    'HYPERNEO_ACP_CONTEXT_WINDOW',
  ],
  providersMisc: [
    'HYPERNEO_PROVIDER_MAX_RETRIES',
    'HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS',
    'HYPERNEO_TASK_NOTIFICATION_REQUERY_BASE_DELAY_MS',
    'HYPERNEO_FILE_INDEX_POLL_MS',
    'HYPERNEO_SPACE_ACTIONS_RATE_LIMIT_PER_MINUTE',
  ],
  spaceEvents: [
    'HYPERNEO_EXTERNAL_EVENT_DIGEST_IDLE_DEBOUNCE_MS',
    'HYPERNEO_EXTERNAL_EVENT_DIGEST_COUNT_CAP',
    'HYPERNEO_EXTERNAL_EVENT_DIGEST_SAFETY_MS',
    'HYPERNEO_EXTERNAL_EVENT_RENDER_DRAIN_MS',
  ],
  startup: [
    'HYPERNEO_MAX_SUBSCRIPTIONS_PER_CLIENT',
    'HYPERNEO_DISABLE_WORKTREES',
    'HYPERNEO_DISABLE_GOAL_PROCESSING',
    'HYPERNEO_LOG_MAX_BYTES',
    'HYPERNEO_LOG_RETAINED_FILES',
    'HYPERNEO_LOG_MAX_PENDING_BYTES',
    'HYPERNEO_SQL_QUERY_OBSERVABILITY',
    'HYPERNEO_SQL_QUERY_SLOW_THRESHOLD_MS',
    'HYPERNEO_SQL_QUERY_SUMMARY_INTERVAL_MS',
    'HYPERNEO_SQL_QUERY_MAX_QUERY_GROUPS',
    'HYPERNEO_SQL_QUERY_SUMMARY_LIMIT',
  ],
  flags: [
    'HYPERNEO_SPACE_ACTIONS_DISPATCHER',
    'HYPERNEO_WORKFLOW_CONNECTORS',
    'HYPERNEO_TASK_AGENT_POST_APPROVAL_ROUTING',
  ],
};

const EXPECTED_RESTART_KEYS = [
  'messageDeliveryMaxConcurrent',
  'jobQueueMaxConcurrent',
  'maxSubscriptionsPerClient',
  'disableWorktrees',
  'disableGoalProcessing',
  'logMaxBytes',
  'logRetainedFiles',
  'logMaxPendingBytes',
  'sqlQueryObservability',
  'sqlQuerySlowThresholdMs',
  'sqlQuerySummaryIntervalMs',
  'sqlQueryMaxQueryGroups',
  'sqlQuerySummaryLimit',
  'spaceActionsDispatcher',
  'workflowConnectors',
  'taskAgentPostApprovalRouting',
];

function entryByKey(key: string): DaemonConfigKeyEntry {
  const entry = DAEMON_CONFIG_KEY_CATALOG.find((e) => e.key === key);
  if (!entry) throw new Error(`missing catalog entry for ${key}`);
  return entry;
}

describe('DAEMON_CONFIG_KEY_CATALOG', () => {
  it('covers every family with the measured key count', () => {
    const counts: Record<string, number> = {};
    for (const entry of DAEMON_CONFIG_KEY_CATALOG)
      counts[entry.family] = (counts[entry.family] ?? 0) + 1;
    expect(counts).toEqual({
      deliveryTiming: 5,
      deliveryPolicy: 3,
      sdkAcp: 4,
      providersMisc: 5,
      spaceEvents: 4,
      startup: 11,
      flags: 3,
    });
    expect(DAEMON_CONFIG_KEY_CATALOG).toHaveLength(35);
  });

  it('has globally unique keys and legacy env names', () => {
    const keys = DAEMON_CONFIG_KEY_CATALOG.map((e) => e.key);
    const envs = DAEMON_CONFIG_KEY_CATALOG.map((e) => e.legacyEnvName);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
    for (const env of envs) expect(env).toMatch(/^HYPERNEO_[A-Z0-9_]+$/);
  });

  it('carries each key historical legacy env name in family order', () => {
    for (const [family, expected] of Object.entries(EXPECTED_ENV_BY_FAMILY)) {
      const envs = DAEMON_CONFIG_KEY_CATALOG.filter((e) => e.family === family).map(
        (e) => e.legacyEnvName
      );
      expect(envs).toEqual(expected);
    }
  });

  it('marks exactly the restart-scoped keys', () => {
    const restartKeys = DAEMON_CONFIG_KEY_CATALOG.filter((e) => e.appliesAt === 'restart')
      .map((e) => e.key)
      .sort();
    expect(restartKeys).toEqual([...EXPECTED_RESTART_KEYS].sort());
  });

  it('keeps measured defaults and ranges', () => {
    expect(entryByKey('messageDeliveryMaxRetries')).toMatchObject({
      type: 'int',
      default: 8,
      min: 1,
      appliesAt: 'live',
    });
    expect(entryByKey('providerMaxRetries')).toMatchObject({ default: 3, min: 0 });
    expect(entryByKey('spaceActionsRateLimitPerMinute')).toMatchObject({ default: 0, min: 0 });
    expect(entryByKey('logRetainedFiles')).toMatchObject({ default: 5, min: 1, max: 1000 });
    expect(entryByKey('sqlQueryObservability')).toMatchObject({
      type: 'boolean',
      default: true,
      appliesAt: 'restart',
    });
    expect(entryByKey('acpContextWindow')).toMatchObject({ default: 200000, min: 1 });
    expect(entryByKey('externalEventDigestCountCap')).toMatchObject({ default: 50 });
  });
});

describe('DEFAULT_DAEMON_CONFIG', () => {
  it('derives a fully populated config from the catalog', () => {
    expect(DEFAULT_DAEMON_CONFIG.deliveryPolicy).toEqual({
      messageDeliveryMaxRetries: 8,
      messageDeliveryMaxConcurrent: 64,
      jobQueueMaxConcurrent: 5,
    });
    expect(DEFAULT_DAEMON_CONFIG.flags).toEqual({
      spaceActionsDispatcher: true,
      workflowConnectors: true,
      taskAgentPostApprovalRouting: true,
    });
    for (const entry of DAEMON_CONFIG_KEY_CATALOG) {
      const family = DEFAULT_DAEMON_CONFIG[entry.family] as Record<string, unknown>;
      expect(family[entry.key]).toBe(entry.default);
    }
  });

  it('resolves absent stored config to defaults', () => {
    expect(resolveDaemonConfig(undefined)).toEqual(DEFAULT_DAEMON_CONFIG);
    expect(resolveDaemonConfig({})).toEqual(DEFAULT_DAEMON_CONFIG);
  });
});

describe('resolveDaemonConfig', () => {
  it('merges stored values over defaults without cross-family leakage', () => {
    const resolved = resolveDaemonConfig({ deliveryPolicy: { messageDeliveryMaxRetries: 3 } });
    expect(resolved.deliveryPolicy?.messageDeliveryMaxRetries).toBe(3);
    expect(resolved.deliveryPolicy?.jobQueueMaxConcurrent).toBe(5);
    expect(resolved.deliveryTiming?.interruptControlTimeoutMs).toBe(2000);
  });

  it('coerces digit-only strings, rejects exotic string forms, and truncates fractions', () => {
    const resolved = resolveDaemonConfig({
      deliveryTiming: {
        interruptControlTimeoutMs: '2500' as unknown as number,
        operationLockAcquireTimeoutMs: 7.9,
        deliveryConsumptionTimeoutMs: '1e3' as unknown as number,
        operationLockLeakCeilingMs: '-5' as unknown as number,
      },
    });
    expect(resolved.deliveryTiming?.interruptControlTimeoutMs).toBe(2500);
    expect(resolved.deliveryTiming?.operationLockAcquireTimeoutMs).toBe(7);
    expect(resolved.deliveryTiming?.deliveryConsumptionTimeoutMs).toBe(30000);
    expect(resolved.deliveryTiming?.operationLockLeakCeilingMs).toBe(900000);
  });

  it('falls back to defaults for non-positive values on positive-only keys', () => {
    const resolved = resolveDaemonConfig({
      deliveryPolicy: { messageDeliveryMaxRetries: 0 },
      sdkAcp: { sdkStartInactivityTimeoutMs: -500 },
      deliveryTiming: { interruptControlTimeoutMs: 0.9 },
    });
    expect(resolved.deliveryPolicy?.messageDeliveryMaxRetries).toBe(8);
    expect(resolved.sdkAcp?.sdkStartInactivityTimeoutMs).toBe(600000);
    expect(resolved.deliveryTiming?.interruptControlTimeoutMs).toBe(2000);
  });

  it('falls back to defaults below min, caps at max, and keeps valid zeros', () => {
    const resolved = resolveDaemonConfig({
      providersMisc: {
        providerMaxRetries: -3,
        spaceActionsRateLimitPerMinute: 0,
        providerRetryBaseDelayMs: 0,
      },
      startup: { logRetainedFiles: 5000 },
    });
    expect(resolved.providersMisc?.providerMaxRetries).toBe(3);
    expect(resolved.providersMisc?.spaceActionsRateLimitPerMinute).toBe(0);
    expect(resolved.providersMisc?.providerRetryBaseDelayMs).toBe(0);
    expect(resolved.startup?.logRetainedFiles).toBe(1000);
  });

  it('rejects unsafe integer values', () => {
    const resolved = resolveDaemonConfig({
      startup: {
        sqlQuerySummaryIntervalMs: '9007199254740993' as unknown as number,
        maxSubscriptionsPerClient: Number.MAX_VALUE,
      },
    });
    expect(resolved.startup?.sqlQuerySummaryIntervalMs).toBe(300000);
    expect(resolved.startup?.maxSubscriptionsPerClient).toBe(128);
  });

  it('falls back to defaults on invalid stored values', () => {
    const resolved = resolveDaemonConfig({
      deliveryTiming: { interruptControlTimeoutMs: 'abc' as unknown as number },
      sdkAcp: { acpContextWindow: Number.NaN },
    });
    expect(resolved.deliveryTiming?.interruptControlTimeoutMs).toBe(2000);
    expect(resolved.sdkAcp?.acpContextWindow).toBe(200000);
  });

  it('coerces booleans including 1/0 and string forms', () => {
    const on = resolveDaemonConfig({
      startup: { disableWorktrees: 1 as unknown as boolean },
      flags: { taskAgentPostApprovalRouting: 'false' as unknown as boolean },
    });
    expect(on.startup?.disableWorktrees).toBe(true);
    expect(on.flags?.taskAgentPostApprovalRouting).toBe(false);
    const off = resolveDaemonConfig({
      startup: { disableWorktrees: 0 as unknown as boolean },
    });
    expect(off.startup?.disableWorktrees).toBe(false);
    const invalid = resolveDaemonConfig({
      flags: { workflowConnectors: 'nope' as unknown as boolean },
    });
    expect(invalid.flags?.workflowConnectors).toBe(true);
  });

  it('applies each boolean key legacy string semantics', () => {
    const perKey = resolveDaemonConfig({
      flags: {
        taskAgentPostApprovalRouting: 'off' as unknown as boolean,
        workflowConnectors: 'off' as unknown as boolean,
        spaceActionsDispatcher: 'yes' as unknown as boolean,
      },
      startup: {
        sqlQueryObservability: 'no' as unknown as boolean,
        disableWorktrees: 'true' as unknown as boolean,
      },
    });
    expect(perKey.flags?.taskAgentPostApprovalRouting).toBe(false);
    expect(perKey.flags?.workflowConnectors).toBe(true);
    expect(perKey.flags?.spaceActionsDispatcher).toBe(false);
    expect(perKey.startup?.sqlQueryObservability).toBe(true);
    expect(perKey.startup?.disableWorktrees).toBe(false);
    const recognizedFalse = resolveDaemonConfig({
      flags: { workflowConnectors: '0' as unknown as boolean },
      startup: { sqlQueryObservability: 'off' as unknown as boolean },
    });
    expect(recognizedFalse.flags?.workflowConnectors).toBe(false);
    expect(recognizedFalse.startup?.sqlQueryObservability).toBe(false);
    const exactMatch = resolveDaemonConfig({
      flags: {
        spaceActionsDispatcher: 'TRUE' as unknown as boolean,
        workflowConnectors: ' 0 ' as unknown as boolean,
        taskAgentPostApprovalRouting: ' NO ' as unknown as boolean,
      },
      startup: { sqlQueryObservability: ' OFF ' as unknown as boolean },
    });
    expect(exactMatch.flags?.spaceActionsDispatcher).toBe(false);
    expect(exactMatch.flags?.workflowConnectors).toBe(true);
    expect(exactMatch.flags?.taskAgentPostApprovalRouting).toBe(false);
    expect(exactMatch.startup?.sqlQueryObservability).toBe(false);
  });
});
