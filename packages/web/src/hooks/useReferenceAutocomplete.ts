import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { sessionStore, type SessionStore } from '../lib/session-store.ts';
import type { ReferenceMention, ReferenceSearchResult } from '@hyperneo/shared';

export interface UseReferenceAutocompleteOptions {
  content: string;
  onSelect: (reference: ReferenceMention) => void;
  store?: SessionStore;
}

export interface UseReferenceAutocompleteResult {
  showAutocomplete: boolean;
  results: ReferenceSearchResult[];
  selectedIndex: number;
  searchQuery: string;
  handleKeyDown: (e: KeyboardEvent) => boolean;
  handleSelect: (result: ReferenceSearchResult) => void;
  close: () => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export function extractActiveAtQuery(content: string): string | null {
  if (!content.includes('@')) return null;

  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i] === '@') {
      const before = i === 0 ? '' : content[i - 1];
      const isWordStart = i === 0 || /\s/.test(before);
      if (!isWordStart) continue;

      const afterAt = content.slice(i + 1);

      if (/\s/.test(afterAt)) continue;

      return afterAt;
    }
  }

  return null;
}

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

export function useReferenceAutocomplete({
  content,
  onSelect,
  store = sessionStore,
}: UseReferenceAutocompleteOptions): UseReferenceAutocompleteResult {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [results, setResults] = useState<ReferenceSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchVersionRef = useRef(0);

  useEffect(() => {
    const query = extractActiveAtQuery(content);

    if (query === null) {
      setShowAutocomplete(false);
      setResults([]);
      setSearchQuery('');
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      return;
    }

    setSearchQuery(query);

    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }

    const version = ++searchVersionRef.current;

    debounceTimerRef.current = setTimeout(async () => {
      debounceTimerRef.current = null;

      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        setShowAutocomplete(false);
        return;
      }

      const sessionId = store.activeSessionId.value;
      if (!sessionId) {
        setShowAutocomplete(false);
        return;
      }

      try {
        const response = await hub.request<{ results: ReferenceSearchResult[] }>(
          'reference.search',
          { sessionId, query }
        );

        if (version !== searchVersionRef.current) return;

        const fetchedResults = response?.results ?? [];
        setResults(fetchedResults);
        setShowAutocomplete(fetchedResults.length > 0);
        setSelectedIndex(0);
      } catch {
        if (version === searchVersionRef.current) {
          setShowAutocomplete(false);
          setResults([]);
        }
      }
    }, SEARCH_DEBOUNCE_MS);
  }, [content]);

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
