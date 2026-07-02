/**
 * ContextUsageBar Component
 *
 * Shows context usage as a circular progress indicator with expandable dropdown:
 * - Circle with percentage and color coding (green → yellow → orange → red)
 * - Clickable to show detailed breakdown by category
 */

import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import type { ContextInfo } from '@hyperneo/shared';
import { borderColors } from '../lib/design-tokens.ts';
import { formatTokens } from '../lib/utils.ts';

interface ContextUsageBarProps {
  contextUsage?: ContextInfo;
  maxContextTokens?: number;
}

// SVG geometry for the circular indicator (r=15, so circumference = 2π·15).
const CIRCLE_RADIUS = 15;
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

// Diagonal-stripe pattern used to mark the autocompact buffer zone as
// visually distinct from the regular free space.
const AUTOCOMPACT_BUFFER_STRIPES =
  'repeating-linear-gradient(135deg, rgba(255,255,255,0.08) 0, rgba(255,255,255,0.08) 2px, transparent 2px, transparent 5px)';

const AUTOCOMPACT_BUFFER_TOOLTIP =
  'Autocompact buffer — reserved for context compression. Not available for conversation.';
const AUTOCOMPACT_THRESHOLD_TOOLTIP = 'Autocompact threshold';

export default function ContextUsageBar({ contextUsage, maxContextTokens }: ContextUsageBarProps) {
  const [showContextDetails, setShowContextDetails] = useState(false);
  const [dropdownBottom, setDropdownBottom] = useState(96); // Default 24*4px = 96px
  const indicatorRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // FIX: Use useCallback to prevent stale closure issues that could cause UI freeze
  const closeDropdown = useCallback(() => {
    setShowContextDetails(false);
  }, []);

  // FIX: Add escape key handler and click outside detection
  // Use document-level detection instead of invisible backdrop div to prevent z-index issues
  useEffect(() => {
    if (!showContextDetails) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDropdown();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      // Close dropdown if click is outside both the dropdown and the indicator
      const target = e.target as Node;
      const isInsideDropdown = dropdownRef.current?.contains(target);
      const isInsideIndicator = indicatorRef.current?.contains(target);

      if (!isInsideDropdown && !isInsideIndicator) {
        closeDropdown();
      }
    };

    // Use capture phase to ensure we catch the event before any stopPropagation
    document.addEventListener('keydown', handleEscape, true);
    // Use timeout to avoid closing immediately from the same click that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside, true);
    }, 0);

    return () => {
      document.removeEventListener('keydown', handleEscape, true);
      document.removeEventListener('click', handleClickOutside, true);
      clearTimeout(timeoutId);
    };
  }, [showContextDetails, closeDropdown]);

  // FIX: Ensure dropdown is closed when component unmounts
  useEffect(() => {
    return () => {
      // Force close on unmount to prevent stale backdrop
      setShowContextDetails(false);
    };
  }, []);

  // Calculate dropdown position dynamically when it opens
  useEffect(() => {
    if (showContextDetails && indicatorRef.current && dropdownRef.current) {
      const indicatorRect = indicatorRef.current.getBoundingClientRect();
      const dropdownHeight = dropdownRef.current.offsetHeight;

      // Calculate space needed: height of dropdown + some padding (16px)
      const _spaceNeeded = dropdownHeight + 16;

      // Position dropdown above the indicator with proper spacing
      const bottomPosition = window.innerHeight - indicatorRect.top + 8;

      setDropdownBottom(bottomPosition);
    }
  }, [showContextDetails]);

  // Only show context info when accurate data is available
  const totalTokens = contextUsage?.totalUsed || 0;
  const contextCapacity =
    contextUsage?.totalCapacity && contextUsage.totalCapacity > 0
      ? contextUsage.totalCapacity
      : maxContextTokens && maxContextTokens > 0
        ? maxContextTokens
        : 0;
  const contextPercentage = contextUsage?.percentUsed || 0;
  const hasContextData = totalTokens > 0;

  // Tokens between the autocompact threshold and total capacity are reserved
  // by the SDK for context compression — not available for conversation. Only
  // render the buffer when the SDK reports auto-compact is enabled with a
  // threshold strictly inside the capacity range.
  const autoCompactThreshold = contextUsage?.autoCompactThreshold ?? 0;
  const showAutoCompactBuffer =
    contextUsage?.isAutoCompactEnabled === true &&
    autoCompactThreshold > 0 &&
    autoCompactThreshold < contextCapacity &&
    contextCapacity > 0;
  const autoCompactThresholdPercent = showAutoCompactBuffer
    ? (autoCompactThreshold / contextCapacity) * 100
    : 0;
  const autoCompactBufferPercent = 100 - autoCompactThresholdPercent;

  // Determine color based on usage - green for lower usage
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

  /**
   * Get color for a specific context category
   */
  const getCategoryColor = (category: string): { bg: string; text: string; dot: string } => {
    const normalizedCategory = category.toLowerCase();

    // System-controlled categories (gray)
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

    // User-configurable MCP tools (purple)
    if (normalizedCategory.includes('mcp tools')) {
      return {
        bg: 'bg-purple-500',
        text: 'text-purple-400',
        dot: 'bg-purple-400',
      };
    }

    // Conversation history (blue)
    if (normalizedCategory.includes('messages')) {
      return { bg: 'bg-blue-500', text: 'text-blue-400', dot: 'bg-blue-400' };
    }

    // Context being sent (cyan)
    if (
      normalizedCategory.includes('input context') ||
      normalizedCategory.includes('input tokens')
    ) {
      return { bg: 'bg-cyan-500', text: 'text-cyan-400', dot: 'bg-cyan-400' };
    }

    // Generated output (green)
    if (normalizedCategory.includes('output tokens') || normalizedCategory.includes('output')) {
      return {
        bg: 'bg-green-500',
        text: 'text-green-400',
        dot: 'bg-green-400',
      };
    }

    // Default color for unknown categories
    return {
      bg: 'bg-indigo-500',
      text: 'text-indigo-400',
      dot: 'bg-indigo-400',
    };
  };

  /**
   * Get sort order for context categories
   */
  const getCategorySortOrder = (category: string): number => {
    const normalizedCategory = category.toLowerCase();

    // Group categories logically
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

    return 99; // Unknown categories go last
  };

  return (
    <>
      {/* Context usage indicator - always show */}
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
        {/* Circle indicator */}
        <svg width="32" height="32" viewBox="0 0 36 36" class="relative">
          <g class="transform rotate-[-90deg]" transform-origin="18 18">
            {/* Background circle */}
            <circle
              cx="18"
              cy="18"
              r={CIRCLE_RADIUS}
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              class="text-dark-700"
            />
            {/* Drawn before the progress arc so the colored fill sits on top. */}
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
            {/* Progress arc */}
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
          {/* Percentage text in center */}
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

      {/* Context Details Dropdown - uses document click detection instead of backdrop */}
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
                  {/* Total Usage */}
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

                  {/* Token Breakdown with colored squares */}
                  {contextUsage?.breakdown && (
                    <div class="space-y-2">
                      <h4 class="text-xs font-medium text-gray-300">Breakdown</h4>
                      <div class="space-y-1.5">
                        {Object.entries(contextUsage.breakdown)
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
                                {/* Colored square icon */}
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

                  {/* Model info */}
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
