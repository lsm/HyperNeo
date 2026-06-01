/**
 * Shared hook for fetching model lists from custom endpoints.
 *
 * Encapsulates the RPC call, loading/error state, and cache-clearing
 * behaviour so parent components (AddProviderModal, ProvidersSettings,
 * CustomEndpointsSettings) don't duplicate the same ~35-line block.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import { listCustomEndpointModels } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { parseHeaders } from './CustomEndpointEditor.tsx';
import type { EditorState } from './CustomEndpointEditor.tsx';

export function useFetchModels(editor: EditorState | null) {
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<Array<{ id: string; name?: string }> | null>(
    null
  );
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  const clearFetchState = useCallback(() => {
    setFetchedModels(null);
    setFetchModelsError(null);
    setFetchedAt(null);
  }, []);

  // Reset fetched state whenever the endpoint connection fields change
  // (baseUrl, type, apiKey, headersText) or when the editor is opened/closed.
  useEffect(() => {
    clearFetchState();
  }, [editor?.baseUrl, editor?.type, editor?.apiKey, editor?.headersText]);

  const handleFetchModels = useCallback(async () => {
    if (!editor) return;
    if (!editor.baseUrl.trim()) {
      toast.error('Base URL is required to fetch models');
      return;
    }
    try {
      setFetchingModels(true);
      setFetchModelsError(null);
      const headers: Record<string, string> = {};
      try {
        const parsed = parseHeaders(editor.headersText);
        if (parsed) Object.assign(headers, parsed);
      } catch {
        // ignore
      }
      const { models } = await listCustomEndpointModels({
        baseUrl: editor.baseUrl.trim(),
        type: editor.type,
        apiKey: editor.apiKey.trim() || undefined,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      });
      setFetchedModels(models);
      setFetchedAt(Date.now());
      if (models.length === 0) {
        toast.info('No models found — you can still enter one manually');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch models';
      setFetchModelsError(msg);
      setFetchedModels(null);
      setFetchedAt(null);
    } finally {
      setFetchingModels(false);
    }
  }, [editor]);

  return {
    fetchingModels,
    fetchedModels,
    fetchModelsError,
    fetchedAt,
    handleFetchModels,
    clearFetchState,
  };
}
