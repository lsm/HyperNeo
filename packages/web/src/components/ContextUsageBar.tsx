import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { ContextInfo } from '@hyperneo/shared';
import { borderColors } from '../lib/design-tokens.ts';
import { formatTokens } from '../lib/utils.ts';

interface ContextUsageBarProps {
  contextUsage?: ContextInfo;
  maxContextTokens?: number;
}

const CIRCLE_RADIUS = 15;
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

const AUTOCOMPACT_BUFFER_STRIPES =
  'repeating-linear-gradient(135deg, rgba(255,255,255,0.08) 0, rgba(255,255,255,0.08) 2px, transparent 2px, transparent 5px)';

const AUTOCOMPACT_BUFFER_TOOLTIP =
  'Autocompact buffer — reserved for context compression. Not available for conversation.';
const AUTOCOMPACT_THRESHOLD_TOOLTIP = 'Autocompact threshold';

export default function ContextUsageBar({ contextUsage, maxContextTokens }: ContextUsageBarProps) {
  const [showContextDetails, setShowContextDetails] = useState(false);
  const [dropdownBottom, setDropdownBottom] = useState(96);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const closeDropdown = useCallback(() => {
    setShowContextDetails(false);
  }, []);

  useEffect(() => {
    if (!showContextDetails) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDropdown();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInsideDropdown = dropdownRef.current?.contains(target);
      const isInsideIndicator = indicatorRef.current?.contains(target);

      if (!isInsideDropdown && !isInsideIndicator) {
        closeDropdown();
      }
    };

    document.addEventListener('keydown', handleEscape, true);
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside, true);
    }, 0);

    return () => {
      document.removeEventListener('keydown', handleEscape, true);
      document.removeEventListener('click', handleClickOutside, true);
      clearTimeout(timeoutId);
    };
  }, [showContextDetails, closeDropdown]);

  useEffect(() => {
    return () => {
      setShowContextDetails(false);
    };
  }, []);

  useEffect(() => {
    if (showContextDetails && indicatorRef.current && dropdownRef.current) {
      const indicatorRect = indicatorRef.current.getBoundingClientRect();
      const dropdownHeight = dropdownRef.current.offsetHeight;

      const _spaceNeeded = dropdownHeight + 16;

      const bottomPosition = window.innerHeight - indicatorRect.top + 8;

      setDropdownBottom(bottomPosition);
    }
  }, [showContextDetails]);

  const totalTokens = contextUsage?.totalUsed || 0;
  const contextCapacity =
    contextUsage?.totalCapacity && contextUsage.totalCapacity > 0
      ? contextUsage.totalCapacity
      : maxContextTokens && maxContextTokens > 0
        ? maxContextTokens
        : 0;
  const contextPercentage = contextUsage?.percentUsed || 0;
  const hasContextData = totalTokens > 0;

  const autoCompactThreshold = contextUsage?.autoCompactThreshold ?? 0;
  const showAutoCompactBuffer =
    (contextUsage?.isAutoCompactEnabled === true || contextUsage?.daemonBackstopActive === true) &&
    autoCompactThreshold > 0 &&
    autoCompactThreshold < contextCapacity &&
    contextCapacity > 0;
  const autoCompactThresholdPercent = showAutoCompactBuffer
    ? (autoCompactThreshold / contextCapacity) * 100
    : 0;
  const autoCompactBufferPercent = 100 - autoCompactThresholdPercent;

  const getContextColor = () => {
    if (contextPercentage >= 90) return 'text-red-400';
    if (contextPercentage >= 75) return 'text-orange-400';
    if (contextPercentage >= 60) return 'text-yellow-400';
    return 'text-green-400';
  };

  const getContextBarColor = () => {
    if (contextPercentage >= 90) return 'bg-red-500';
    if (contextPercentage >= 75) return 'bg-orange-500';
    if (contextPercentage >= 60) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  const getCategoryColor = (category: string): { bg: string; text: string; dot: string } => {
    const normalizedCategory = category.toLowerCase();

    if (normalizedCategory.includes('system prompt')) {
      return { bg: 'bg-gray-600', text: 'text-gray-400', dot: 'bg-gray-400' };
    }
    if (normalizedCategory.includes('system tools')) {
      return { bg: 'bg-gray-600', text: 'text-gray-400', dot: 'bg-gray-400' };
    }
    if (normalizedCategory.includes('autocompact')) {
      return { bg: 'bg-gray-600', text: 'text-gray-400', dot: 'bg-gray-400' };
    }
    if (normalizedCategory.includes('free space')) {
      return { bg: 'bg-gray-700', text: 'text-gray-500', dot: 'bg-gray-500' };
    }

    if (normalizedCategory.includes('mcp tools')) {
      return {
        bg: 'bg-purple-500',
        text: 'text-purple-400',
        dot: 'bg-purple-400',
      };
    }

    if (normalizedCategory.includes('messages')) {
      return { bg: 'bg-blue-500', text: 'text-blue-400', dot: 'bg-blue-400' };
    }

    if (
      normalizedCategory.includes('input context') ||
      normalizedCategory.includes('input tokens')
    ) {
      return { bg: 'bg-cyan-500', text: 'text-cyan-400', dot: 'bg-cyan-400' };
    }

    if (normalizedCategory.includes('output tokens') || normalizedCategory.includes('output')) {
      return {
        bg: 'bg-green-500',
        text: 'text-green-400',
        dot: 'bg-green-400',
      };
    }

    return {
      bg: 'bg-indigo-500',
      text: 'text-indigo-400',
      dot: 'bg-indigo-400',
    };
  };

  const getCategorySortOrder = (category: string): number => {
    const normalizedCategory = category.toLowerCase();

    if (normalizedCategory.includes('system prompt')) return 1;
    if (normalizedCategory.includes('system tools')) return 2;
    if (normalizedCategory.includes('mcp tools')) return 3;
    if (normalizedCategory.includes('messages')) return 4;
    if (normalizedCategory.includes('input context') || normalizedCategory.includes('input tokens'))
      return 5;
    if (normalizedCategory.includes('output tokens') || normalizedCategory.includes('output'))
      return 6;
    if (normalizedCategory.includes('autocompact')) return 7;
    if (normalizedCategory.includes('free space')) return 8;

    return 99;
  };

  return (
    <>
      <div
        ref={indicatorRef}
        class={`flex items-center gap-3 transition-opacity ${
          hasContextData ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
        }`}
        onClick={() => {
          if (hasContextData) {
            setShowContextDetails(!showContextDetails);
          }
        }}
        title={hasContextData ? 'Click for context details' : 'Context data loading...'}
      >
        <svg width="32" height="32" viewBox="0 0 36 36" class="relative">
          <g class="transform rotate-[-90deg]" transform-origin="18 18">
            <circle
              cx="18"
              cy="18"
              r={CIRCLE_RADIUS}
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              class="text-dark-700"
            />
            {showAutoCompactBuffer && (
              <circle
                data-testid="autocompact-buffer-arc"
                cx="18"
                cy="18"
                r={CIRCLE_RADIUS}
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-dasharray={`0 ${(autoCompactThresholdPercent / 100) * CIRCLE_CIRCUMFERENCE} ${(autoCompactBufferPercent / 100) * CIRCLE_CIRCUMFERENCE} 0`}
                class="text-dark-500 opacity-70"
              >
                <title>{AUTOCOMPACT_BUFFER_TOOLTIP}</title>
              </circle>
            )}
            <circle
              cx="18"
              cy="18"
              r={CIRCLE_RADIUS}
              fill="none"
              stroke="currentColor"
              stroke-width="4"
              stroke-dasharray={`${(contextPercentage / 100) * CIRCLE_CIRCUMFERENCE} ${CIRCLE_CIRCUMFERENCE}`}
              class={`transition-all duration-300 ${
                contextPercentage >= 90
                  ? 'text-red-500'
                  : contextPercentage >= 75
                    ? 'text-orange-500'
                    : contextPercentage >= 60
                      ? 'text-yellow-500'
                      : 'text-green-500'
              }`}
              stroke-linecap="round"
            />
          </g>
          <text
            x="18"
            y="18"
            text-anchor="middle"
            dominant-baseline="middle"
            font-size="12"
            class={`font-bold fill-current ${getContextColor()}`}
          >
            {Math.round(contextPercentage)}
          </text>
        </svg>
      </div>

      {showContextDetails && hasContextData && (
        <div class="fixed right-0 px-4 z-50" style={{ bottom: `${dropdownBottom}px` }}>
          <div class="max-w-4xl mx-auto flex justify-end">
            <div ref={dropdownRef}>
              <div
                class={`bg-dark-800 border ${borderColors.ui.secondary} rounded-lg p-4 w-72 shadow-xl`}
              >
                <div class="flex items-center justify-between mb-3">
                  <h3 class="text-sm font-semibold text-gray-200">Context Usage</h3>
                  <button
                    class="text-gray-400 hover:text-gray-200 transition-colors"
                    onClick={closeDropdown}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      class="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>

                <div class="space-y-3">
                  <div class="bg-dark-700 rounded-lg p-2.5">
                    <div class="flex justify-between items-center mb-1.5">
                      <span class="text-xs text-gray-400">Context Window</span>
                      <span class={`text-xs font-semibold ${getContextColor()}`}>
                        {contextPercentage.toFixed(1)}%
                      </span>
                    </div>
                    <div class="relative w-full h-2.5 bg-dark-600 rounded-full overflow-hidden">
                      {showAutoCompactBuffer && (
                        <div
                          data-testid="autocompact-buffer-zone"
                          class="absolute top-0 right-0 h-full bg-dark-500/70"
                          style={{
                            width: `${autoCompactBufferPercent}%`,
                            backgroundImage: AUTOCOMPACT_BUFFER_STRIPES,
                          }}
                          title={AUTOCOMPACT_BUFFER_TOOLTIP}
                        />
                      )}
                      <div
                        class={`absolute top-0 left-0 h-full transition-all duration-300 ${getContextBarColor()}`}
                        style={{
                          width: `${Math.min(contextPercentage, 100)}%`,
                        }}
                      />
                      {showAutoCompactBuffer && (
                        <div
                          data-testid="autocompact-threshold-marker"
                          class="absolute top-0 h-full w-px bg-amber-500/60"
                          style={{ left: `${autoCompactThresholdPercent}%` }}
                          title={AUTOCOMPACT_THRESHOLD_TOOLTIP}
                        />
                      )}
                    </div>
                    <div class="text-xs text-gray-500 mt-1">
                      {totalTokens.toLocaleString()} / {contextCapacity.toLocaleString()}
                    </div>
                  </div>

                  {contextUsage?.breakdown && (
                    <div class="space-y-2">
                      <h4 class="text-xs font-medium text-gray-300">Breakdown</h4>
                      <div class="space-y-1.5">
                        {Object.entries(contextUsage.breakdown)
                          .filter(([category]) => !category.toLowerCase().includes('autocompact'))
                          .sort(
                            ([categoryA], [categoryB]) =>
                              getCategorySortOrder(categoryA) - getCategorySortOrder(categoryB)
                          )
                          .map(([category, data]) => {
                            const { bg, text } = getCategoryColor(category);
                            const percentage =
                              data.percent !== null
                                ? data.percent
                                : contextCapacity > 0
                                  ? (data.tokens / contextCapacity) * 100
                                  : 0;
                            return (
                              <div key={category} class="flex items-center gap-2 text-xs">
                                <div class={`w-3 h-3 rounded ${bg} flex-shrink-0`} />
                                <span class="text-gray-400 flex-1 min-w-0 truncate">
                                  {category}
                                </span>
                                <span class={`${text} font-medium`}>{percentage.toFixed(1)}%</span>
                                <span class="text-gray-200 font-mono text-xs">
                                  {formatTokens(data.tokens)}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}

                  {contextUsage?.model && (
                    <div class={`pt-3 border-t ${borderColors.ui.default}`}>
                      <div class="flex items-center gap-2 text-xs">
                        <svg
                          class="w-3.5 h-3.5 text-gray-400"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width={2}
                            d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
                          />
                        </svg>
                        <span class="text-gray-400">Model:</span>
                        <span class="text-gray-200 font-mono">{contextUsage.model}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
