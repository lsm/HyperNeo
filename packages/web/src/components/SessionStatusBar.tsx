import type { ContextInfo, ModelInfo, ThinkingLevel } from '@hyperneo/shared';
import { getThinkingOptionsForProvider, THINKING_LEVEL_LABELS } from '@hyperneo/shared';
import type { ProviderAuthStatus } from '@hyperneo/shared/provider';
import { useSignalEffect } from '@preact/signals';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  getProviderLabel,
  groupModelsByProvider,
  useClickOutside,
  useFilteredModelsForPicker,
  useMessageHub,
  useModal,
} from '../hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { borderColors } from '../lib/design-tokens.ts';
import type { IndicatorTone } from '../lib/indicator-tokens.ts';
import {
  providerHeaderStyle,
  providerLogoColor,
  providerPillStyle,
  shortenModelName,
} from '../lib/provider-brand.ts';
import { type ConnectionState, connectionState } from '../lib/state.ts';
import ConnectionStatus from './ConnectionStatus.tsx';
import ContextUsageBar from './ContextUsageBar.tsx';
import { ProviderLogo } from './ProviderLogo.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';
import { Spinner } from './ui/Spinner.tsx';
import { StatusDot } from './ui/StatusDot.tsx';
import { Tooltip } from './ui/Tooltip.tsx';

function ThinkingLevelIcon({ level }: { level: ThinkingLevel }) {
  const brightnessMap: Record<ThinkingLevel, number> = {
    off: 0,
    think8k: 1,
    think16k: 2,
    think24k: 3,
    think32k: 4,
  };
  const brightness = brightnessMap[level];

  const strokeColor =
    brightness === 0
      ? 'text-gray-400'
      : brightness === 1
        ? 'text-amber-600'
        : brightness === 2
          ? 'text-amber-500'
          : brightness === 3
            ? 'text-amber-400'
            : 'text-amber-300';

  const fillOpacity =
    brightness === 0
      ? 0
      : brightness === 1
        ? 0.15
        : brightness === 2
          ? 0.3
          : brightness === 3
            ? 0.4
            : 0.5;

  return (
    <svg class={`w-4 h-4 ${strokeColor}`} viewBox="0 0 24 24">
      {brightness > 0 && (
        <circle
          cx="12"
          cy="10"
          r={brightness === 1 ? 4 : brightness === 2 ? 5 : brightness === 3 ? 5.5 : 6}
          fill="currentColor"
          opacity={fillOpacity}
        />
      )}
      <path
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
      />
    </svg>
  );
}

function ThinkingBorderRing({ level }: { level: ThinkingLevel }) {
  if (level === 'off') return null;

  const size = 32;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  const dashPercentMap: Record<ThinkingLevel, number> = {
    off: 0,
    think8k: 0.25,
    think16k: 0.5,
    think24k: 0.75,
    think32k: 1,
  };
  const dashPercent = dashPercentMap[level];
  const dashLength = circumference * dashPercent;

  const strokeColor =
    level === 'think8k'
      ? '#d97706'
      : level === 'think16k'
        ? '#f59e0b'
        : level === 'think24k'
          ? '#fbbf24'
          : '#fde68a';

  return (
    <svg class="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={strokeColor}
        stroke-width={strokeWidth}
        stroke-dasharray={`${dashLength} ${circumference - dashLength}`}
        stroke-dashoffset={circumference * 0.25}
        stroke-linecap="round"
      />
    </svg>
  );
}

interface SessionStatusBarProps {
  sessionId: string;
  isProcessing: boolean;
  currentAction?: string;
  streamingPhase?: 'initializing' | 'thinking' | 'streaming' | 'finalizing' | null;
  contextUsage?: ContextInfo;
  maxContextTokens?: number;
  currentModel: string;
  currentModelInfo: ModelInfo | null;
  availableModels: ModelInfo[];
  modelSwitching: boolean;
  modelLoading: boolean;
  onModelSwitch: (model: ModelInfo) => void;
  autoScroll: boolean;
  onAutoScrollChange: (enabled: boolean) => void;
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => Promise<void> | void;
  coordinatorSwitching?: boolean;
  isRecovering?: boolean;
}

export default function SessionStatusBar({
  sessionId: _sessionId,
  isProcessing,
  currentAction,
  streamingPhase,
  contextUsage,
  maxContextTokens,
  currentModel: _currentModel,
  currentModelInfo,
  availableModels,
  modelSwitching,
  modelLoading,
  onModelSwitch,
  autoScroll,
  onAutoScrollChange,
  thinkingLevel: thinkingLevelProp,
  onThinkingLevelChange,
  coordinatorSwitching = false,
  isRecovering = false,
}: SessionStatusBarProps) {
  const [connState, setConnState] = useState<ConnectionState>(connectionState.value);

  useSignalEffect(() => {
    setConnState(connectionState.value);
  });

  const { callIfConnected } = useMessageHub();

  const [providerAuthStatuses, setProviderAuthStatuses] = useState<Map<string, ProviderAuthStatus>>(
    new Map()
  );
  const [modelSearchQuery, setModelSearchQuery] = useState('');

  const loadAuthStatuses = useCallback(() => {
    let cancelled = false;
    callIfConnected('auth.providers', {})
      .then((res) => {
        if (cancelled) return;
        const result = res as { providers?: ProviderAuthStatus[] } | null;
        const statusMap = new Map<string, ProviderAuthStatus>();
        for (const p of result?.providers ?? []) {
          statusMap.set(p.id, p);
        }
        setProviderAuthStatuses(statusMap);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [callIfConnected]);

  useEffect(() => {
    return loadAuthStatuses();
  }, [loadAuthStatuses]);

  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;
    const unsub = hub.onEvent('providers.changed', () => {
      loadAuthStatuses();
    });
    return () => {
      unsub();
    };
  }, [loadAuthStatuses, connectionState.value]);

  const modelDropdown = useModal();
  const thinkingDropdown = useModal();
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(modelDropdownRef, modelDropdown.close, modelDropdown.isOpen);
  useClickOutside(thinkingDropdownRef, thinkingDropdown.close, thinkingDropdown.isOpen);

  const toggleModelDropdown = useCallback(() => {
    if (modelDropdown.isOpen) {
      modelDropdown.close();
    } else {
      thinkingDropdown.close();
      setModelSearchQuery('');
      modelDropdown.open();
    }
  }, [modelDropdown, thinkingDropdown]);

  const toggleThinkingDropdown = useCallback(() => {
    if (thinkingDropdown.isOpen) {
      thinkingDropdown.close();
    } else {
      modelDropdown.close();
      thinkingDropdown.open();
    }
  }, [modelDropdown, thinkingDropdown]);

  useEffect(() => {
    if (isRecovering) {
      modelDropdown.close();
      thinkingDropdown.close();
    }
  }, [isRecovering, modelDropdown, thinkingDropdown]);

  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(thinkingLevelProp || 'off');

  useEffect(() => {
    setThinkingLevel(thinkingLevelProp || 'off');
  }, [thinkingLevelProp]);

  const thinkingOptions = getThinkingOptionsForProvider(
    currentModelInfo?.provider,
    currentModelInfo?.thinkingModes
  );

  const handleAutoScrollToggle = useCallback(() => {
    onAutoScrollChange(!autoScroll);
  }, [autoScroll, onAutoScrollChange]);

  const handleModelSwitch = useCallback(
    async (model: ModelInfo) => {
      await onModelSwitch(model);
      setModelSearchQuery('');
      modelDropdown.close();
    },
    [onModelSwitch, modelDropdown]
  );

  useEffect(() => {
    if (!modelDropdown.isOpen) {
      setModelSearchQuery('');
    }
  }, [modelDropdown.isOpen]);

  const handleThinkingLevelChange = useCallback(
    async (level: ThinkingLevel) => {
      setThinkingLevel(level);
      thinkingDropdown.close();

      if (onThinkingLevelChange) {
        await onThinkingLevelChange(level);
        return;
      }

      await callIfConnected('session.thinking.set', {
        sessionId: _sessionId,
        level,
      });
    },
    [_sessionId, callIfConnected, thinkingDropdown, onThinkingLevelChange]
  );

  const activeProvider = currentModelInfo?.provider;
  const pillStyle = providerPillStyle(activeProvider);
  const tierLabel = currentModelInfo ? shortenModelName(currentModelInfo.name, activeProvider) : '';
  const filteredModels = useFilteredModelsForPicker(
    availableModels,
    providerAuthStatuses,
    currentModelInfo?.provider,
    currentModelInfo?.id,
    modelSearchQuery
  );
  const groupedFilteredModels = groupModelsByProvider(filteredModels);
  const glassControlButtonBaseClass =
    'control-btn w-8 h-8 flex items-center justify-center rounded-full bg-transparent backdrop-blur-sm hover:bg-dark-800/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <ContentContainer className="pb-2 flex items-center gap-4 justify-between">
      <ConnectionStatus
        connectionState={isRecovering && connState === 'connected' ? 'reconnecting' : connState}
        isProcessing={isRecovering ? false : isProcessing}
        currentAction={isRecovering ? undefined : currentAction}
        streamingPhase={isRecovering ? undefined : streamingPhase}
      />

      <div class="flex min-w-0 items-center gap-3 sm:gap-4">
        <div class="flex min-w-0 items-center gap-1.5">
          <div class="relative" ref={modelDropdownRef}>
            <Tooltip
              content={currentModelInfo ? `Model: ${currentModelInfo.name}` : 'Switch Model'}
              position="top"
              delay={300}
            >
              <button
                data-testid="model-pill"
                data-provider={activeProvider ?? ''}
                class="control-btn inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full border pl-2 pr-2.5 text-xs text-gray-200 transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                style={pillStyle}
                onClick={toggleModelDropdown}
                disabled={modelLoading || modelSwitching || coordinatorSwitching || isRecovering}
                title={
                  currentModelInfo ? `Switch Model (${currentModelInfo.name})` : 'Switch Model'
                }
              >
                {modelSwitching ? (
                  <Spinner size="sm" />
                ) : currentModelInfo ? (
                  <>
                    <span
                      class="flex shrink-0"
                      style={{ color: providerLogoColor(activeProvider) }}
                    >
                      <ProviderLogo provider={activeProvider ?? 'anthropic'} class="h-4 w-4" />
                    </span>
                    <span class="min-w-0 max-w-[88px] sm:max-w-[150px] truncate font-medium">
                      {tierLabel || currentModelInfo.name}
                    </span>
                    <svg
                      class="h-3 w-3 shrink-0 text-gray-500"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        fill-rule="evenodd"
                        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                        clip-rule="evenodd"
                      />
                    </svg>
                  </>
                ) : (
                  <span class="px-1 text-gray-400">Select model</span>
                )}
              </button>
            </Tooltip>

            {modelDropdown.isOpen && (
              <div
                data-testid="model-dropdown"
                class={`absolute bottom-full mb-2 left-0 bg-dark-800 border ${borderColors.ui.secondary} rounded-lg shadow-xl w-72 py-1 z-50 animate-slideIn max-h-[60vh] flex flex-col`}
              >
                <div class="px-3 py-1.5 text-xs font-semibold text-gray-400">Select Model</div>
                <div class="px-2 pb-2">
                  <input
                    type="search"
                    value={modelSearchQuery}
                    onInput={(e) => setModelSearchQuery(e.currentTarget.value)}
                    placeholder="Search models..."
                    aria-label="Search models"
                    class="w-full bg-dark-900 border border-dark-600 rounded px-2 py-1.5 text-xs text-gray-100 placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div class="flex-1 min-h-0 overflow-y-auto">
                  {Array.from(groupedFilteredModels.entries()).map(
                    ([provider, models], groupIndex) => {
                      const authStatus = providerAuthStatuses.get(provider);
                      const isAuthenticated = authStatus?.isAuthenticated;
                      const needsRefresh = authStatus?.needsRefresh ?? false;
                      const isTransient = authStatus?.errorKind === 'transient';
                      const availabilityTone: IndicatorTone =
                        isAuthenticated === undefined || isTransient
                          ? 'neutral'
                          : !isAuthenticated
                            ? 'danger'
                            : needsRefresh
                              ? 'warning'
                              : 'success';
                      return (
                        <div key={provider} data-testid="provider-section">
                          {groupIndex > 0 && <div class="mx-2 my-1 border-t border-gray-700" />}
                          <div
                            class="flex items-center gap-1.5 px-3 py-1.5"
                            style={providerHeaderStyle(provider)}
                          >
                            <span class="flex h-3.5 w-3.5 shrink-0">
                              <ProviderLogo provider={provider} class="h-3.5 w-3.5" />
                            </span>
                            <span
                              data-testid="provider-group-header"
                              class="text-[11px] font-bold uppercase tracking-wider"
                            >
                              {getProviderLabel(provider)}
                            </span>
                            <StatusDot tone={availabilityTone} />
                            {needsRefresh && (
                              <span class="text-yellow-400 text-[10px]" title="Token expiring soon">
                                ⚠
                              </span>
                            )}
                          </div>
                          {models.map((model) => {
                            const isCurrent =
                              model.id === currentModelInfo?.id &&
                              model.provider === currentModelInfo?.provider;
                            return (
                              <button
                                key={`${model.provider}:${model.id}`}
                                class={`w-full text-left px-3 py-1.5 hover:bg-dark-700 text-xs flex items-center gap-2 ${
                                  isCurrent ? 'text-blue-400' : 'text-gray-200'
                                }`}
                                onClick={() => handleModelSwitch(model)}
                                disabled={modelSwitching}
                              >
                                <span class="flex-1 truncate">
                                  {shortenModelName(model.name, model.provider)}
                                </span>
                                {isCurrent && <span class="text-blue-400 text-[10px]">✓</span>}
                                {needsRefresh && (
                                  <span class="text-yellow-400 text-[10px]" title="Token expiring">
                                    ⚠
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      );
                    }
                  )}
                  {filteredModels.length === 0 && (
                    <div class="px-3 py-4 text-xs text-gray-500 text-center">
                      No matching models
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {thinkingOptions.length > 0 && (
          <div class="relative" ref={thinkingDropdownRef}>
            <Tooltip
              content={`Thinking: ${THINKING_LEVEL_LABELS[thinkingLevel]}`}
              position="top"
              delay={300}
            >
              <button
                class={`${glassControlButtonBaseClass} relative ${
                  thinkingLevel === 'off' ? 'border-dark-600/80' : 'border-transparent'
                }`}
                onClick={toggleThinkingDropdown}
                disabled={isRecovering}
                title={`Thinking: ${THINKING_LEVEL_LABELS[thinkingLevel]}`}
              >
                <ThinkingBorderRing level={thinkingLevel} />
                <ThinkingLevelIcon level={thinkingLevel} />
              </button>
            </Tooltip>

            {thinkingDropdown.isOpen && (
              <div
                class={`absolute bottom-full mb-2 left-0 bg-dark-800 border ${borderColors.ui.secondary} rounded-lg shadow-xl w-40 py-1 z-50 animate-slideIn`}
              >
                <div class="px-3 py-1.5 text-xs font-semibold text-gray-400">Thinking Level</div>
                {thinkingOptions.map((option) => (
                  <button
                    key={option.value}
                    class={`w-full text-left px-3 py-2 hover:bg-dark-700 text-xs flex items-center gap-2 ${
                      option.value === thinkingLevel ? 'text-amber-400' : 'text-gray-200'
                    }`}
                    onClick={() => handleThinkingLevelChange(option.value)}
                    disabled={isRecovering}
                  >
                    <ThinkingLevelIcon level={option.value} />
                    {option.label}
                    {option.value === thinkingLevel && ' (current)'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <Tooltip
          content={`Auto-scroll (${autoScroll ? 'enabled' : 'disabled'})`}
          position="top"
          delay={300}
        >
          <button
            class={`${glassControlButtonBaseClass} ${
              autoScroll ? 'border-2 border-emerald-500' : 'border border-dark-600/80'
            }`}
            onClick={handleAutoScrollToggle}
            title={`Auto-scroll (${autoScroll ? 'enabled' : 'disabled'})`}
          >
            <svg
              class={`w-4 h-4 transition-colors ${autoScroll ? 'text-emerald-400' : 'text-gray-500'}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 14l-7 7m0 0l-7-7m7 7V3"
              />
            </svg>
          </button>
        </Tooltip>

        <div class="h-6 w-px bg-gray-600" />

        <ContextUsageBar contextUsage={contextUsage} maxContextTokens={maxContextTokens} />
      </div>
    </ContentContainer>
  );
}
