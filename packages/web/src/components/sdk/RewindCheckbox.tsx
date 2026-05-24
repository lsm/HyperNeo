import type { JSX } from 'preact';

/**
 * Parameters for rendering the rewind mode checkbox
 */
export interface RewindCheckboxParams {
  /** Whether rewind mode is active */
  rewindMode: boolean | undefined;
  /** Message UUID (required for checkbox to render) */
  messageUuid: string | undefined;
  /** Callback when checkbox state changes */
  onMessageCheckboxChange?: (uuid: string, checked: boolean) => void;
  /** Set of currently selected message UUIDs */
  selectedMessages?: Set<string>;
  /** Whether this message has sub-agent children (skips checkbox if true) */
  hasSubagentChild?: boolean;
}

/**
 * Renders a rewind mode checkbox for message selection.
 * Returns null if any of the required conditions are not met.
 *
 * This is a pure function extracted for testability and reusability.
 * Used by both SDKAssistantMessage and SDKUserMessage components.
 *
 * @param params - Checkbox rendering parameters
 * @returns JSX checkbox input or null
 */
export function renderRewindCheckbox(params: RewindCheckboxParams): JSX.Element | null {
  const { rewindMode, messageUuid, onMessageCheckboxChange, selectedMessages, hasSubagentChild } =
    params;

  // Skip if has sub-agent children (assistant messages only)
  if (hasSubagentChild) {
    return null;
  }

  // Skip if not in rewind mode or missing required props
  if (!rewindMode || !messageUuid || !onMessageCheckboxChange) {
    return null;
  }

  return (
    <input
      type="checkbox"
      checked={selectedMessages?.has(messageUuid) || false}
      onChange={(e) => onMessageCheckboxChange(messageUuid, (e.target as HTMLInputElement).checked)}
      class="w-5 h-5 appearance-none rounded border border-gray-600 bg-gray-800 dark:bg-gray-700 text-amber-500 focus:ring-amber-500 focus:ring-2 focus:ring-offset-gray-900 cursor-pointer transition-colors checked:bg-amber-500 checked:border-amber-500 hover:border-gray-500 checked:hover:bg-amber-600 checked:hover:border-amber-600 relative before:absolute before:inset-0 before:flex before:items-center before:justify-center before:content-['✓'] before:text-white before:text-sm before:font-bold before:opacity-0 checked:before:opacity-100 flex-shrink-0"
    />
  );
}
