/**
 * useReferenceAutocomplete Hook
 *
 * Manages @ reference autocomplete state: detection, RPC search with debouncing,
 * and keyboard navigation.
 *
 * Follows the same pattern as `useCommandAutocomplete` but for @ references.
 *
 * Detection: Triggers when the cursor is immediately after an active @query
 * (i.e. the text from the last unspaced @ to the end of content has no whitespace).
 * Works anywhere in the text, not just at the start.
 *
 * Multiple @ support: Only the "active" @ (closest to the end of content with
 * no space between it and the end) triggers autocomplete.  Once the user selects
 * a result, the @query is replaced and the previous tokens are left untouched.
 */

import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { sessionStore } from '../lib/session-store.ts';
import type { ReferenceMention, ReferenceSearchResult } from '@hyperneo/shared';

export interface UseReferenceAutocompleteOptions {
  content: string;
  onSelect: (reference: ReferenceMention) => void;
}

export interface UseReferenceAutocompleteResult {
  showAutocomplete: boolean;
  results: ReferenceSearchResult[];
  selectedIndex: number;
  /** Active query string (text after the triggering @) */
  searchQuery: string;
  handleKeyDown: (e: KeyboardEvent) => boolean;
  handleSelect: (result: ReferenceSearchResult) => void;
  close: () => void;
}

/** Debounce delay in ms for reference.search RPC calls */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Given a text string (the content up to the cursor), return the active query
 * if the user is currently typing an @ reference, otherwise null.
 *
 * Rules:
 * - Find the last @ that is preceded by whitespace or start-of-string
 * - The text between that @ and the end of content must not contain any whitespace
 *
 * Returns the query string (may be empty if user just typed "@").
 * Note: `@@` returns `"@"` as the query — this is intentional (the inner `@` is
 * treated as the query text). Consumers that insert `@ref{type:id}` should append
 * a trailing space so that the token does not re-trigger autocomplete.
 */
export function extractActiveAtQuery(content: string): string | null {
  if (!content.includes('@')) return null;

  // Walk backwards from end to find last word-start @
  // A word-start @ is one preceded by whitespace or at position 0
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i] === '@') {
      const before = i === 0 ? '' : content[i - 1];
      const isWordStart = i === 0 || /\s/.test(before);
      if (!isWordStart) continue;

      // Text after the @ to end of content
      const afterAt = content.slice(i + 1);

      // Must contain no whitespace (user is still typing the reference)
      if (/\s/.test(afterAt)) continue;

      return afterAt;
    }
  }

  return null;
}

/**
 * Replace the active @query at the end of content with an @ref{type:id} token.
 *
 * Finds the suffix "@" + query at the end of content and replaces it with
 * the formatted token followed by a space so the token does not re-trigger
 * autocomplete. Returns content unchanged if the suffix is not found.
 */
export function insertReferenceMention(
  content: string,
  query: string,
  mention: ReferenceMention
): string {
  const atQuery = '@' + query;
  if (!content.endsWith(atQuery)) return content;
  const token = `@ref{${mention.type}:${mention.id}} `;
  return content.slice(0, content.length - atQuery.length) + token;
}

/**
 * Hook for managing @ reference autocomplete
 */
export function useReferenceAutocomplete({
  content,
  onSelect,
}: UseReferenceAutocompleteOptions): UseReferenceAutocompleteResult {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [results, setResults] = useState<ReferenceSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  // Debounce timer ref — cancelled on new input
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Abort flag — set when a new search supersedes an in-progress one
  const searchVersionRef = useRef(0);

  // Detection: extract active query from content
  useEffect(() => {
    const query = extractActiveAtQuery(content);

    if (query === null) {
      setShowAutocomplete(false);
      setResults([]);
      setSearchQuery('');
      // Cancel any pending search
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      return;
    }

    setSearchQuery(query);

    // Cancel previous debounce timer
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }

    // Bump version to cancel any in-flight search
    const version = ++searchVersionRef.current;

    debounceTimerRef.current = setTimeout(async () => {
      debounceTimerRef.current = null;

      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        setShowAutocomplete(false);
        return;
      }

      const sessionId = sessionStore.activeSessionId.value;
      if (!sessionId) {
        setShowAutocomplete(false);
        return;
      }

      try {
        const response = await hub.request<{ results: ReferenceSearchResult[] }>(
          'reference.search',
          { sessionId, query }
        );

        // Discard stale responses
        if (version !== searchVersionRef.current) return;

        const fetchedResults = response?.results ?? [];
        setResults(fetchedResults);
        setShowAutocomplete(fetchedResults.length > 0);
        setSelectedIndex(0);
      } catch {
        // Ignore search errors (backend may not have the handler yet)
        if (version === searchVersionRef.current) {
          setShowAutocomplete(false);
          setResults([]);
        }
      }
    }, SEARCH_DEBOUNCE_MS);
  }, [content]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const close = useCallback(() => {
    setShowAutocomplete(false);
    setResults([]);
    setSelectedIndex(0);
  }, []);

  const handleSelect = useCallback(
    (result: ReferenceSearchResult) => {
      const mention: ReferenceMention = {
        type: result.type,
        id: result.id,
        displayText: result.displayText,
      };
      onSelect(mention);
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
        setSelectedIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
        return true;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
        return true;
      } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex]);
        }
        return true;
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return true;
      }

      return false;
    },
    [showAutocomplete, results, selectedIndex, handleSelect, close]
  );

  return {
    showAutocomplete,
    results,
    selectedIndex,
    searchQuery,
    handleKeyDown,
    handleSelect,
    close,
  };
}
