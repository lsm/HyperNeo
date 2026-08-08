/**
 * useCommandAutocomplete Hook
 *
 * Handles slash command detection, filtering, and keyboard navigation.
 * Extracted from MessageInput.tsx for better separation of concerns.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { sessionStore, type SessionStore } from '../lib/session-store.ts';

export interface UseCommandAutocompleteOptions {
  content: string;
  onSelect: (command: string) => void;
  /**
   * SessionStore whose slash commands this autocomplete reads. Defaults to the
   * singleton; an overlaid chat passes its dedicated instance so the dropdown
   * reflects that view's session, not the primary chat's.
   */
  store?: SessionStore;
}

export interface UseCommandAutocompleteResult {
  showAutocomplete: boolean;
  filteredCommands: string[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  handleSelect: (command: string) => void;
  handleKeyDown: (e: KeyboardEvent) => boolean;
  close: () => void;
}

/**
 * Hook for managing slash command autocomplete
 */
export function useCommandAutocomplete({
  content,
  onSelect,
  store = sessionStore,
}: UseCommandAutocompleteOptions): UseCommandAutocompleteResult {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filteredCommands, setFilteredCommands] = useState<string[]>([]);

  // Read per-session commands signal in render scope to subscribe to changes.
  // Uses the (optionally injected) store's commandsData (computed from
  // sessionState) rather than the global slashCommandsSignal, so it always
  // reflects THIS view's session's commands. Guard with Array.isArray:
  // corrupted sessions may have a string stored in DB.
  const rawCommands = store.commandsData.value;

  // Stabilize the array reference: only return a new reference when command values
  // actually change. This prevents the useEffect below from re-running (and
  // re-showing a closed dropdown) when the server sends a new array object with
  // identical command names (e.g. periodic state syncs that JSON-parse the same data).
  const prevCmdsRef = useRef<string[]>([]);
  const availableCommands = useMemo(() => {
    const cmds = Array.isArray(rawCommands) ? rawCommands : [];
    const prev = prevCmdsRef.current;
    if (cmds.length === prev.length && cmds.every((c, i) => c === prev[i])) {
      return prev;
    }
    prevCmdsRef.current = cmds;
    return cmds;
  }, [rawCommands]);

  // Detect slash commands
  useEffect(() => {
    const trimmedContent = content.trimStart();

    if (trimmedContent.startsWith('/') && availableCommands.length > 0) {
      const query = trimmedContent.slice(1).toLowerCase();
      const filtered = availableCommands.filter((cmd) => cmd.toLowerCase().includes(query));

      setFilteredCommands(filtered);
      setShowAutocomplete(filtered.length > 0);
      setSelectedIndex(0);
    } else {
      setShowAutocomplete(false);
      setFilteredCommands([]);
    }
  }, [content, availableCommands]);

  const close = useCallback(() => {
    setShowAutocomplete(false);
  }, []);

  const handleSelect = useCallback(
    (command: string) => {
      onSelect(command);
      setShowAutocomplete(false);
    },
    [onSelect]
  );

  // Handle keyboard navigation, returns true if event was handled
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!showAutocomplete) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev < filteredCommands.length - 1 ? prev + 1 : 0));
        return true;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredCommands.length - 1));
        return true;
      } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (filteredCommands[selectedIndex]) {
          handleSelect(filteredCommands[selectedIndex]);
        }
        return true;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowAutocomplete(false);
        return true;
      }

      return false;
    },
    [showAutocomplete, filteredCommands, selectedIndex, handleSelect]
  );

  return {
    showAutocomplete,
    filteredCommands,
    selectedIndex,
    setSelectedIndex,
    handleSelect,
    handleKeyDown,
    close,
  };
}
