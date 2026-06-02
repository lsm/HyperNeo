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

import { useSignalEffect } from '@preact/signals';
import { useState, useCallback, useEffect, useRef } from 'preact/hooks';
import type { ContextInfo, ModelInfo, ThinkingLevel, SessionFeatures } from '@neokai/shared';
import type { ProviderAuthStatus } from '@neokai/shared/provider';
import {
  DEFAULT_WORKER_FEATURES,
  THINKING_LEVEL_LABELS,
  getThinkingOptionsForProvider,
} from '@neokai/shared';
import { connectionState, type ConnectionState } from '../lib/state.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import ConnectionStatus from './ConnectionStatus.tsx';
import ContextUsageBar from './ContextUsageBar.tsx';
import { ContentContainer } from './ui/ContentContainer.tsx';
import {
  useModal,
  useClickOutside,
  getModelFamilyIcon,
  getProviderLabel,
  groupModelsByProvider,
  useFilteredModelsForPicker,
  useMessageHub,
} from '../hooks';
import { Spinner } from './ui/Spinner.tsx';
import { Tooltip } from './ui/Tooltip.tsx';
import { borderColors } from '../lib/design-tokens.ts';

/**
 * Brand-accurate provider dot colors (hex values outside Tailwind's palette).
 * Keep in sync with PROVIDER_LABELS in packages/web/src/hooks/useModelSwitcher.ts —
 * when a new provider is added there, add a matching entry here.
 */
const PROVIDER_DOT_COLORS: Record<string, { color: string; ring?: boolean }> = {
  anthropic: { color: '#D97757' }, // Anthropic brand orange
  'anthropic-copilot': { color: '#8957E5' }, // GitHub Copilot purple
  'anthropic-codex': { color: '#FFFFFF', ring: true }, // OpenAI white (ring for visibility)
  openrouter: { color: '#007CF0' }, // OpenRouter blue
  glm: { color: '#7DD3FC' }, // ChatGLM light blue
  kimi: { color: '#B197FC' }, // Kimi/Moonshot lavender
  minimax: { color: '#FCA5A5' }, // MiniMax light red
};

/**
 * ProviderBadge - Small colored dot indicating the provider next to the model name.
 * Shows for all providers including Anthropic (orange dot).
 * Returns null only when provider is undefined/unknown.
 * The dot's title/aria-label provide the provider name for accessibility.
 */
function ProviderBadge({ provider }: { provider: string | undefined }) {
  if (!provider) return null;
  const config = PROVIDER_DOT_COLORS[provider];
  const backgroundColor = config?.color ?? '#9CA3AF'; // gray-400 fallback
  const label = getProviderLabel(provider);
  return (
    <span
      class={`inline-block w-2 h-2 rounded-full flex-shrink-0${config?.ring ? ' ring-1 ring-gray-300' : ''}`}
      style={{ backgroundColor }}
      title={label}
      aria-label={label}
      role="img"
      data-testid="provider-badge"
    />
  );
}

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
  // Feature flags (for unified session architecture)
  features?: SessionFeatures;
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
  // Coordinator mode
  coordinatorMode: boolean;
  coordinatorSwitching?: boolean;
  onCoordinatorModeChange: (enabled: boolean) => void;
  // Sandbox mode
  sandboxEnabled: boolean;
  sandboxSwitching?: boolean;
  onSandboxModeChange: (enabled: boolean) => void;
  // Thinking level
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => Promise<void> | void;
}

export default function SessionStatusBar({
  sessionId: _sessionId,
  isProcessing,
  currentAction,
  streamingPhase,
  contextUsage,
  maxContextTokens,
  features = DEFAULT_WORKER_FEATURES,
  currentModel: _currentModel,
  currentModelInfo,
  availableModels,
  modelSwitching,
  modelLoading,
  onModelSwitch,
  autoScroll,
  onAutoScrollChange,
  coordinatorMode,
  coordinatorSwitching = false,
  onCoordinatorModeChange,
  sandboxEnabled,
  sandboxSwitching = false,
  onSandboxModeChange,
  thinkingLevel: thinkingLevelProp,
  onThinkingLevelChange,
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

  // Coordinator mode toggle handler
  const handleCoordinatorModeToggle = useCallback(() => {
    onCoordinatorModeChange(!coordinatorMode);
  }, [coordinatorMode, onCoordinatorModeChange]);

  // Sandbox mode toggle handler
  const handleSandboxModeToggle = useCallback(() => {
    onSandboxModeChange(!sandboxEnabled);
  }, [sandboxEnabled, onSandboxModeChange]);

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

  // Get current model icon
  const currentModelIcon = currentModelInfo ? getModelFamilyIcon(currentModelInfo.family) : '💎';
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
      {/* Left: Connection status */}
      <ConnectionStatus
        connectionState={connState}
        isProcessing={isProcessing}
        currentAction={currentAction}
        streamingPhase={streamingPhase}
      />

      {/* Right: Interactive controls and context usage */}
      <div class="flex items-center gap-3 sm:gap-4">
        {/* Coordinator Mode Toggle - only show if feature is enabled */}
        {features.coordinator && (
          <Tooltip
            content={`Coordinator Mode (${coordinatorMode ? 'enabled' : 'disabled'})`}
            position="top"
            delay={300}
          >
            <button
              class={`${glassControlButtonBaseClass} ${
                coordinatorMode ? 'border-2 border-purple-500' : 'border border-dark-600/80'
              }`}
              onClick={handleCoordinatorModeToggle}
              disabled={coordinatorSwitching || modelSwitching}
              title={`Coordinator Mode (${coordinatorMode ? 'enabled' : 'disabled'})`}
            >
              {coordinatorSwitching ? (
                <Spinner size="sm" />
              ) : (
                <svg
                  class={`w-4 h-4 transition-colors ${coordinatorMode ? 'text-purple-400' : 'text-gray-500'}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                  />
                </svg>
              )}
            </button>
          </Tooltip>
        )}

        {/* Sandbox Mode Toggle - only show if feature is enabled */}
        {features.worktree && (
          <Tooltip
            content={`Sandbox Mode (${sandboxEnabled ? 'enabled' : 'disabled'})`}
            position="top"
            delay={300}
          >
            <button
              class={`${glassControlButtonBaseClass} ${
                sandboxEnabled ? 'border-2 border-green-500' : 'border border-dark-600/80'
              }`}
              onClick={handleSandboxModeToggle}
              disabled={sandboxSwitching || modelSwitching}
              title={`Sandbox Mode (${sandboxEnabled ? 'enabled' : 'disabled'})`}
            >
              {sandboxSwitching ? (
                <Spinner size="sm" />
              ) : (
                <svg
                  class={`w-4 h-4 transition-colors ${sandboxEnabled ? 'text-green-400' : 'text-gray-500'}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                  />
                </svg>
              )}
            </button>
          </Tooltip>
        )}

        {/* Model Switcher + Provider Badge */}
        <div class="flex items-center gap-1.5">
          <div class="relative" ref={modelDropdownRef}>
            <Tooltip
              content={currentModelInfo ? `Model: ${currentModelInfo.name}` : 'Switch Model'}
              position="top"
              delay={300}
            >
              <button
                class={`${glassControlButtonBaseClass} border border-dark-600/80 text-lg`}
                onClick={toggleModelDropdown}
                disabled={modelLoading || modelSwitching || coordinatorSwitching}
                title={
                  currentModelInfo ? `Switch Model (${currentModelInfo.name})` : 'Switch Model'
                }
              >
                {modelSwitching ? <Spinner size="sm" /> : currentModelIcon}
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
                      // Dot: gray = unknown, green = ok, yellow = expiring, red = unauthenticated (only current shown)
                      const dotClass =
                        isAuthenticated === undefined
                          ? 'bg-gray-500'
                          : !isAuthenticated
                            ? 'bg-red-500'
                            : needsRefresh
                              ? 'bg-yellow-500'
                              : 'bg-green-500';
                      return (
                        <div key={provider} data-testid="provider-section">
                          {groupIndex > 0 && <div class="mx-2 my-1 border-t border-gray-700" />}
                          <div class="px-3 py-1 flex items-center gap-1.5">
                            <span class={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`} />
                            <span
                              data-testid="provider-group-header"
                              class="text-[10px] font-semibold text-gray-400 uppercase tracking-wide"
                            >
                              {getProviderLabel(provider)}
                            </span>
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
                                <span class="text-base">{getModelFamilyIcon(model.family)}</span>
                                <span class="flex-1 truncate">{model.name}</span>
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
          <ProviderBadge provider={currentModelInfo?.provider} />
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
