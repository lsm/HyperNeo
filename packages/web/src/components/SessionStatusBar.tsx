/**
 * SessionStatusBar Component
 *
 * Container component that displays connection status, interactive controls, and context usage
 * in a horizontal bar above the message input.
 *
 * Layout:
 * - Left: ConnectionStatus (Online/Offline/Connecting/Processing status)
 * - Center: Interactive controls (Model switcher, Auto-scroll, Thinking level)
 * - Right: ContextUsageBar (percentage + progress bar + dropdown)
 *
 * Uses the global connectionState signal directly for guaranteed reactivity.
 */

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

// Provider brand colors + logos live in lib/provider-brand.ts and
// components/ProviderLogo.tsx (shared with the model picker).

/**
 * ThinkingLevelIcon - Lightbulb icon with progressive lighting based on thinking level
 *
 * - off: Dim (gray) - no glow
 * - think8k: 1/4 lit (amber glow, dim bulb)
 * - think16k: 1/2 lit (amber glow, medium bulb)
 * - think24k: 3/4 lit (amber glow, bright medium bulb)
 * - think32k: Full lit (bright amber glow, bright bulb)
 */
function ThinkingLevelIcon({ level }: { level: ThinkingLevel }) {
  // Map level to brightness: 0 = off, 1 = 1/4, 2 = 1/2, 3 = 3/4, 4 = full
  const brightnessMap: Record<ThinkingLevel, number> = {
    off: 0,
    think8k: 1,
    think16k: 2,
    think24k: 3,
    think32k: 4,
  };
  const brightness = brightnessMap[level];

  // Color based on brightness level
  // off: slightly brighter white, non-off: progressive amber
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

  // Fill opacity for the bulb (glow effect)
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
      {/* Glow effect behind the bulb */}
      {brightness > 0 && (
        <circle
          cx="12"
          cy="10"
          r={brightness === 1 ? 4 : brightness === 2 ? 5 : brightness === 3 ? 5.5 : 6}
          fill="currentColor"
          opacity={fillOpacity}
        />
      )}
      {/* Lightbulb outline */}
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

/**
 * ThinkingBorderRing - SVG ring that shows partial border lighting
 *
 * Uses stroke-dasharray to create partial circle effect:
 * - think8k: 1/4 of circle lit (90 degrees)
 * - think16k: 1/2 of circle lit (180 degrees)
 * - think24k: 3/4 of circle lit (270 degrees)
 * - think32k: Full circle lit (360 degrees)
 */
function ThinkingBorderRing({ level }: { level: ThinkingLevel }) {
  if (level === 'off') return null;

  // Circle parameters (matches w-8 h-8 = 32px button)
  const size = 32;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2; // 15
  const circumference = 2 * Math.PI * radius; // ~94.25

  // Calculate dash length based on level
  const dashPercentMap: Record<ThinkingLevel, number> = {
    off: 0,
    think8k: 0.25,
    think16k: 0.5,
    think24k: 0.75,
    think32k: 1,
  };
  const dashPercent = dashPercentMap[level];
  const dashLength = circumference * dashPercent;

  // Color based on level
  const strokeColor =
    level === 'think8k'
      ? '#d97706'
      : level === 'think16k'
        ? '#f59e0b'
        : level === 'think24k'
          ? '#fbbf24'
          : '#fde68a'; // amber-600, amber-500, amber-400, amber-300

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
        stroke-dashoffset={circumference * 0.25} // Start from top (rotate -90deg)
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
  // Model switcher
  currentModel: string;
  currentModelInfo: ModelInfo | null;
  availableModels: ModelInfo[];
  modelSwitching: boolean;
  modelLoading: boolean;
  onModelSwitch: (model: ModelInfo) => void;
  // Auto-scroll
  autoScroll: boolean;
  onAutoScrollChange: (enabled: boolean) => void;
  // Thinking level
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => Promise<void> | void;
  // Coordinator switching guard for the model pill
  coordinatorSwitching?: boolean;
  /**
   * Per-session recovery flag (distinct from the global transport state). While
   * true THIS session is rejoining its channel and re-syncing — the connection
   * dot must read "Reconnecting…" (not "Ready") to match the recovery banner,
   * and model controls stay disabled so the user can't switch models mid-sync.
   */
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
  // Use useState + useSignalEffect to ensure component re-renders on signal change
  // This is more explicit than relying on implicit signal tracking
  const [connState, setConnState] = useState<ConnectionState>(connectionState.value);

  useSignalEffect(() => {
    setConnState(connectionState.value);
  });

  // Get MessageHub for RPC calls
  const { callIfConnected } = useMessageHub();

  // Provider auth statuses for availability dots and model filtering in model picker
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
      .catch(() => {
        // Silently ignore — dots just stay gray
      });
    return () => {
      cancelled = true;
    };
  }, [callIfConnected]);

  useEffect(() => {
    return loadAuthStatuses();
  }, [loadAuthStatuses]);

  // Refresh auth statuses when providers change so the picker filter stays current.
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

  // Dropdowns - only one can be open at a time
  const modelDropdown = useModal();
  const thinkingDropdown = useModal();
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(modelDropdownRef, modelDropdown.close, modelDropdown.isOpen);
  useClickOutside(thinkingDropdownRef, thinkingDropdown.close, thinkingDropdown.isOpen);

  // Helper to toggle dropdown and close the other one
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

  // Close any open dropdown the moment this session enters recovery — otherwise
  // disabling only the trigger leaves the model/thinking options mounted and
  // clickable (their buttons gate solely on modelSwitching), letting the user
  // start a model switch while the session is rejoining and re-syncing.
  useEffect(() => {
    if (isRecovering) {
      modelDropdown.close();
      thinkingDropdown.close();
    }
  }, [isRecovering, modelDropdown, thinkingDropdown]);

  // Thinking level state (synced from session config)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(thinkingLevelProp || 'off');

  // Sync thinking level with session config changes
  useEffect(() => {
    setThinkingLevel(thinkingLevelProp || 'off');
  }, [thinkingLevelProp]);

  // Provider-aware thinking options — prefer runtime model thinkingModes (set by
  // providers whose capability depends on runtime config, e.g. bridge adapter)
  // falling back to the static PROVIDER_THINKING_MODES map.
  const thinkingOptions = getThinkingOptionsForProvider(
    currentModelInfo?.provider,
    currentModelInfo?.thinkingModes
  );

  // Auto-scroll toggle handler
  const handleAutoScrollToggle = useCallback(() => {
    onAutoScrollChange(!autoScroll);
  }, [autoScroll, onAutoScrollChange]);

  // Model switch handler
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

  // Thinking level change handler with persistence
  const handleThinkingLevelChange = useCallback(
    async (level: ThinkingLevel) => {
      setThinkingLevel(level);
      thinkingDropdown.close();

      if (onThinkingLevelChange) {
        await onThinkingLevelChange(level);
        return;
      }

      // Persist to session config via RPC
      await callIfConnected('session.thinking.set', {
        sessionId: _sessionId,
        level,
      });
    },
    [_sessionId, callIfConnected, thinkingDropdown, onThinkingLevelChange]
  );

  // Brand-tinted model pill: the provider logo carries identity (color + mark),
  // the tier label carries the model. The separate identity dot is gone — the
  // logo IS the provider now.
  const activeProvider = currentModelInfo?.provider;
  const pillStyle = providerPillStyle(activeProvider);
  const tierLabel = currentModelInfo ? shortenModelName(currentModelInfo.name, activeProvider) : '';
  const filteredModels = useFilteredModelsForPicker(
    availableModels,
    providerAuthStatuses,
    currentModelInfo?.provider,
    modelSearchQuery
  );
  const groupedFilteredModels = groupModelsByProvider(filteredModels);
  const glassControlButtonBaseClass =
    'control-btn w-8 h-8 flex items-center justify-center rounded-full bg-transparent backdrop-blur-sm hover:bg-dark-800/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <ContentContainer className="pb-2 flex items-center gap-4 justify-between">
      {/* Left: Connection status.
          Harmonized with per-session recovery (task #873): when the transport
          is connected but THIS session is still rejoining its channel, show
          "Reconnecting…" instead of a contradictory "Ready". The global
          disconnected/reconnecting/failed states pass through unchanged.
          Mask the (stale) processing inputs while recovering — resolveStatus
          prioritizes isProcessing/currentAction over connectionState, so a
          cached processing state would otherwise show the agent's last action
          during the exact recovery window this labels "Reconnecting…". */}
      <ConnectionStatus
        connectionState={isRecovering && connState === 'connected' ? 'reconnecting' : connState}
        isProcessing={isRecovering ? false : isProcessing}
        currentAction={isRecovering ? undefined : currentAction}
        streamingPhase={isRecovering ? undefined : streamingPhase}
      />

      {/* Right: Interactive controls and context usage */}
      <div class="flex min-w-0 items-center gap-3 sm:gap-4">
        {/* Model Switcher + Provider Badge */}
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

            {/* Model Dropdown */}
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
                      // Availability dot tone: neutral = unknown, success = ok,
                      // warning = expiring, danger = unauthenticated. Drives the
                      // dot from the unified indicator foundation.
                      const availabilityTone: IndicatorTone =
                        isAuthenticated === undefined
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

        {/* Thinking Level — hidden when provider doesn't support thinking */}
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
                title={`Thinking: ${THINKING_LEVEL_LABELS[thinkingLevel]}`}
              >
                <ThinkingBorderRing level={thinkingLevel} />
                <ThinkingLevelIcon level={thinkingLevel} />
              </button>
            </Tooltip>

            {/* Thinking Dropdown */}
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

        {/* Auto-scroll Toggle - Highlighted border and icon when active */}
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

        {/* Separator */}
        <div class="h-6 w-px bg-gray-600" />

        {/* Context usage */}
        <ContextUsageBar contextUsage={contextUsage} maxContextTokens={maxContextTokens} />
      </div>
    </ContentContainer>
  );
}
