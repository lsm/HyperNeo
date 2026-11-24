import type { GlobalSettings, ProviderRecord, SessionConfig } from '@hyperneo/shared';
import {
  isOxapHarness,
  isOxapModelLocked,
  OXAP_HARNESSES,
  oxapHarness,
  oxapThinkingOptions,
  type OxapHarness,
} from '@hyperneo/shared/types/oxap-harnesses';
import superpipe, { type PipelineAPI } from 'superpipe';
import { findInModels, getAvailableModels } from '../model-service.ts';
import { savedOxapAdapter } from '../oxap/oxap-hub-config.ts';

export type SessionEngine = NonNullable<SessionConfig['harness']>;

export class OxapSessionAdmissionError extends Error {}

export function selectSessionEngine(harness: unknown): SessionEngine {
  if (harness === undefined || harness === 'sdk') return 'sdk';
  if (isOxapHarness(harness)) return harness;
  throw new Error(`Unknown session harness: ${String(harness)}`);
}

export function engineForProvider(
  providerId: string,
  record: () => Pick<ProviderRecord, 'configJson'> | null
): SessionEngine {
  const rows: OxapHarness[] = Object.values(OXAP_HARNESSES);
  if (!rows.some((row) => row.providers.includes(providerId))) return 'sdk';
  let config: unknown;
  try {
    config = JSON.parse(record()?.configJson ?? '{}');
  } catch {
    throw new Error(`Provider ${providerId} has an unreadable config`);
  }
  const harness =
    config && typeof config === 'object' ? (config as { harness?: unknown }).harness : undefined;
  if (harness === undefined) return 'sdk';
  if (isOxapHarness(harness) && oxapHarness(harness).providers.includes(providerId)) return harness;
  throw new Error(`Provider ${providerId} names an unsupported harness: ${String(harness)}`);
}

export function sdkFallbackProviders<T extends { id: string }>(
  providers: T[],
  record: (providerId: string) => Pick<ProviderRecord, 'configJson'> | null
): T[] {
  return providers.filter((provider) => {
    try {
      return engineForProvider(provider.id, () => record(provider.id)) === 'sdk';
    } catch {
      return false;
    }
  });
}

export function effectiveOxapConfig(
  config: Partial<SessionConfig>,
  global: Pick<GlobalSettings, 'permissionMode' | 'sandbox' | 'coordinatorMode'>
): Partial<SessionConfig> {
  return {
    ...config,
    permissionMode: config.permissionMode ?? global.permissionMode,
    sandbox: config.sandbox ?? global.sandbox,
    coordinatorMode: config.coordinatorMode ?? global.coordinatorMode,
  };
}

const UNENFORCED_RESTRICTION =
  'OXAP Codex runs with on-request approval in the workspace; this restriction is not supported';

const isSet = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  !(Array.isArray(value) && value.length === 0) &&
  !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

function unenforced(config: Partial<SessionConfig>): boolean {
  const sandbox = config.sandbox;
  return (
    (config.permissionMode !== undefined && config.permissionMode !== 'default') ||
    config.coordinatorMode === true ||
    (['tools', 'sdkToolsPreset', 'allowedTools', 'disallowedTools'] as const).some(
      (field) => config[field] !== undefined
    ) ||
    sandbox?.enabled === true ||
    isSet(sandbox?.filesystem?.denyRead) ||
    isSet(sandbox?.filesystem?.denyWrite) ||
    (
      [
        'maxTurns',
        'maxBudgetUsd',
        'mcpServers',
        'additionalDirectories',
        'maxThinkingTokens',
      ] as const
    ).some((field) => isSet(config[field]))
  );
}

function decideCodexAdmission(
  config: Partial<SessionConfig>,
  space: boolean,
  neoRoot: boolean,
  runtimeGuards = false
): string | undefined {
  if (
    config.systemPrompt !== undefined ||
    config.agent !== undefined ||
    config.agents !== undefined
  ) {
    return 'Codex session instructions are not supported yet.';
  }
  if (
    (config.toolGuards !== undefined &&
      (!Array.isArray(config.toolGuards) || config.toolGuards.length > 0)) ||
    runtimeGuards ||
    (config.workerOperations !== undefined && config.workerOperations !== false) ||
    space ||
    neoRoot
  ) {
    return 'Codex is not supported for sessions requiring tool guards, worker operations, Space, or Neo.';
  }
  if (unenforced(config)) return UNENFORCED_RESTRICTION;
  return undefined;
}

export const codexSessionRefusal = (superpipe({})('oap.session.admission') as PipelineAPI)
  .input(['config', 'space', 'neoRoot', 'runtimeGuards'])
  .pipe(decideCodexAdmission, ['config', 'space', 'neoRoot', 'runtimeGuards'], 'reason')
  .end('reason') as typeof decideCodexAdmission;

function switchGate(
  config: Pick<SessionConfig, 'harness' | 'provider'>,
  provider: string | undefined,
  target: SessionEngine
) {
  if (provider === undefined || provider === config.provider) return { value: true as const };
  const current = selectSessionEngine(config.harness);
  if (isOxapHarness(current))
    return { reason: `An ${oxapHarness(current).label} chat cannot change its provider.` };
  if (isOxapHarness(target))
    return {
      reason: `A Claude Code chat cannot move to an ${oxapHarness(target).label} provider.`,
    };
  return { value: true as const };
}

export const decideSwitch = (superpipe({})('session.switch.admission') as PipelineAPI)
  .input(['config', 'provider', 'target'])
  .pipe(switchGate, ['config', 'provider', 'target'], 'result:switch')
  .end('switch') as (
  config: Pick<SessionConfig, 'harness' | 'provider'>,
  provider: string | undefined,
  target: SessionEngine
) => true | string;

function openGate(
  config: Pick<SessionConfig, 'harness' | 'provider'>,
  record: Pick<ProviderRecord, 'configJson'> | null
) {
  const harness = selectSessionEngine(config.harness);
  if (!isOxapHarness(harness) || !config.provider)
    return { reason: 'This chat has no OXAP provider.' };
  const saved = record && savedOxapAdapter({ providerId: config.provider, ...record });
  if (saved?.harness !== harness)
    return {
      reason: `This chat ran on ${oxapHarness(harness).label}, which this provider no longer uses; start a new chat`,
    };
  return { value: { adapter: config.provider } };
}

export const decideOxapOpen = (superpipe({})('oap.session.open') as PipelineAPI)
  .input(['config', 'record'])
  .pipe(openGate, ['config', 'record'], 'result:open')
  .end('open') as (
  config: Pick<SessionConfig, 'harness' | 'provider'>,
  record: Pick<ProviderRecord, 'configJson'> | null
) => { adapter: string } | string;

export function thinkingRefusal(
  harness: SessionConfig['harness'],
  thinkingLevel: unknown,
  model?: string
): string | undefined {
  if (thinkingLevel === undefined || !isOxapHarness(harness)) return undefined;
  if (harness === 'oxap-codex') {
    const info =
      model &&
      findInModels(
        getAvailableModels().filter((m) => m.provider === 'anthropic-codex'),
        model
      );
    return oxapThinkingOptions(harness, info || null).some(({ value }) => value === thinkingLevel)
      ? undefined
      : `OXAP Codex model ${model ?? 'selection'} does not publish support for this thinking level.`;
  }
  if (thinkingLevel === 'off') return undefined;
  const row = oxapHarness(harness);
  return row.thinking ? undefined : `${row.label} does not take a thinking level.`;
}

export function oxapModelSwitchRefusal(
  config: Pick<SessionConfig, 'harness' | 'model' | 'thinkingLevel'>,
  nativeSessionId: string | null | undefined,
  model: string | undefined,
  thinkingLevel = config.thinkingLevel
): string | undefined {
  if (
    model !== undefined &&
    model !== config.model &&
    isOxapModelLocked(config.harness, nativeSessionId)
  )
    return 'This DeepSeek thread has a fixed model. Start a new chat to use another model.';
  if (
    config.harness === 'oxap-codex' &&
    model &&
    model !== config.model &&
    !thinkingRefusal(config.harness, config.thinkingLevel, config.model)
  ) {
    return thinkingRefusal(config.harness, thinkingLevel, model);
  }
  return undefined;
}
