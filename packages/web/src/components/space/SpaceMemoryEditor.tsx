import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { memoryStore } from '../../lib/memory-store';
import { toast } from '../../lib/toast';

const KEY_MAX_LENGTH = 200;
const CONTENT_MAX_LENGTH = 10_000;
const TAG_MAX_LENGTH = 50;
const TAG_MAX_COUNT = 50;
const KEY_CHECK_DEBOUNCE_MS = 250;

export interface SpaceMemoryEditorProps {
  memory: AgentMemoryEntry | null;
  existingKeys: string[];
  onClose: () => void;
}

function parseTagsInput(input: string): string[] {
  return input
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function SpaceMemoryEditor({ memory, existingKeys, onClose }: SpaceMemoryEditorProps) {
  const isEditing = memory !== null;
  const [key, setKey] = useState(memory?.key ?? '');
  const [content, setContent] = useState(memory?.content ?? '');
  const [tagsInput, setTagsInput] = useState(memory?.tags.join(', ') ?? '');
  const initialTagsInput = memory?.tags.join(', ') ?? '';
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteDuplicate, setRemoteDuplicate] = useState(false);

  const trimmedKey = key.trim();
  const duplicateKey =
    !isEditing && trimmedKey !== '' && (existingKeys.includes(trimmedKey) || remoteDuplicate);

  useEffect(() => {
    if (isEditing || trimmedKey === '' || existingKeys.includes(trimmedKey)) {
      setRemoteDuplicate(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const exists = await memoryStore.exists(trimmedKey);
      if (!cancelled) setRemoteDuplicate(exists);
    }, KEY_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [trimmedKey, isEditing, existingKeys]);

  const guardedClose = saving ? () => undefined : onClose;

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const handleSave = async () => {
    setError(null);

    const trimmedContent = content.trim();

    if (!isEditing && !trimmedKey) {
      setError('Key is required.');
      return;
    }
    if (duplicateKey) {
      setError(
        'A memory with this key already exists. Edit it instead, or choose a different key.'
      );
      return;
    }
    if (!trimmedContent) {
      setError('Content is required.');
      return;
    }
    const tagsChanged = tagsInput !== initialTagsInput;
    const tags = tagsChanged ? parseTagsInput(tagsInput) : undefined;
    if (tags) {
      const oversizedTag = tags.find((tag) => tag.length > TAG_MAX_LENGTH);
      if (oversizedTag) {
        setError(`Tags must be ${TAG_MAX_LENGTH} characters or fewer.`);
        return;
      }
      if (tags.length > TAG_MAX_COUNT) {
        setError(`A memory can have at most ${TAG_MAX_COUNT} tags.`);
        return;
      }
    }

    setSaving(true);
    try {
      const entry = isEditing
        ? await memoryStore.write({ key: trimmedKey, content: trimmedContent, tags })
        : await memoryStore.create({ key: trimmedKey, content: trimmedContent, tags });
      if (!mountedRef.current) return;
      toast.success(`Memory "${entry.key}" saved`);
      onClose();
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to save memory';
      setError(message);
      toast.error(message);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={guardedClose}
      showCloseButton={!saving}
      title={isEditing ? 'Edit Memory' : 'New Memory'}
      size="md"
    >
      <div class="space-y-4">
        <div>
          <label class="mb-1 block text-xs font-medium text-fg-soft" htmlFor="memory-key">
            Key
          </label>
          <input
            id="memory-key"
            type="text"
            value={key}
            onInput={(e) => setKey((e.target as HTMLInputElement).value)}
            disabled={isEditing || saving}
            maxLength={KEY_MAX_LENGTH}
            placeholder="unique-key"
            class="w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none disabled:opacity-60"
            data-testid="memory-key-input"
          />
          <p class="mt-1 text-xs text-fg-faint">
            {isEditing
              ? 'Key cannot be changed — delete and recreate to rename.'
              : 'A short, unique identifier for this memory within the space.'}
          </p>
          {duplicateKey && (
            <p class="mt-1 text-xs text-warning" data-testid="memory-duplicate-key-warning">
              A memory with this key already exists — edit it instead, or choose a different key.
            </p>
          )}
        </div>

        <div>
          <label class="mb-1 block text-xs font-medium text-fg-soft" htmlFor="memory-content">
            Content
          </label>
          <textarea
            id="memory-content"
            value={content}
            onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
            disabled={saving}
            maxLength={CONTENT_MAX_LENGTH}
            rows={6}
            placeholder="The fact, convention, or decision to remember…"
            class="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
            data-testid="memory-content-input"
          />
          <p class="mt-1 text-right text-xs text-fg-faint">
            {content.length}/{CONTENT_MAX_LENGTH}
          </p>
        </div>

        <div>
          <label class="mb-1 block text-xs font-medium text-fg-soft" htmlFor="memory-tags">
            Tags
          </label>
          <input
            id="memory-tags"
            type="text"
            value={tagsInput}
            onInput={(e) => setTagsInput((e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="convention, feedback, project"
            class="w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
            data-testid="memory-tags-input"
          />
          <p class="mt-1 text-xs text-fg-faint">Comma-separated keywords that improve retrieval.</p>
        </div>

        {error && (
          <p
            class="rounded-lg border border-danger/50 bg-danger/20 px-3 py-2 text-sm text-danger"
            data-testid="memory-editor-error"
          >
            {error}
          </p>
        )}

        <div class="flex items-center justify-end gap-3 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} data-testid="memory-save-button">
            {isEditing ? 'Save Changes' : 'Create Memory'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
