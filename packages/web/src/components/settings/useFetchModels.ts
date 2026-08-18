import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
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

  const activeRequestRef = useRef(0);

  const clearFetchState = useCallback(() => {
    setFetchedModels(null);
    setFetchModelsError(null);
    setFetchedAt(null);
  }, []);

  useEffect(() => {
    clearFetchState();
    activeRequestRef.current++;
    setFetchingModels(false);
  }, [editor?.baseUrl, editor?.type, editor?.apiKey, editor?.headersText]);

  const handleFetchModels = useCallback(async () => {
    if (!editor) return;
    if (!editor.baseUrl.trim()) {
      toast.error('Base URL is required to fetch models');
      return;
    }

    const reqId = ++activeRequestRef.current;

    let headers: Record<string, string> | undefined;
    try {
      headers = parseHeaders(editor.headersText) ?? undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid headers';
      setFetchModelsError(msg);
      return;
    }

    try {
      setFetchingModels(true);
      setFetchModelsError(null);
      const { models } = await listCustomEndpointModels({
        baseUrl: editor.baseUrl.trim(),
        type: editor.type,
        apiKey: editor.apiKey.trim() || undefined,
        headers,
      });
      if (reqId !== activeRequestRef.current) return;
      setFetchedModels(models);
      setFetchedAt(Date.now());
      if (models.length === 0) {
        toast.info('No models found — you can still enter one manually');
      }
    } catch (e) {
      if (reqId !== activeRequestRef.current) return;
      const msg = e instanceof Error ? e.message : 'Failed to fetch models';
      setFetchModelsError(msg);
      setFetchedModels(null);
      setFetchedAt(null);
    } finally {
      if (reqId === activeRequestRef.current) {
        setFetchingModels(false);
      }
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
