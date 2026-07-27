/**
 * SpaceMemoryEditor Component
 *
 * Modal form for creating or editing a single agent memory within the active
 * space. Create mode (memory === null) lets the user set the key; edit mode
 * locks the key (the daemon upserts on (spaceId, key), so changing the key
 * would create a new memory rather than rename — we avoid that footgun).
 *
 * Validation mirrors the daemon's normalize* rules so the user gets inline
 * feedback before the round-trip.
 */

import { useState } from 'preact/hooks';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { memoryStore } from '../../lib/memory-store';
import { toast } from '../../lib/toast';

const KEY_MAX_LENGTH = 200;
const CONTENT_MAX_LENGTH = 10_000;
const TAG_MAX_LENGTH = 50;

export interface SpaceMemoryEditorProps {
  /** Existing memory to edit, or null to create a new one. */
  memory: AgentMemoryEntry | null;
  /** Keys already present in the space, to warn on create-mode collisions. */
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedKey = key.trim();
  // Create-mode collision: the daemon upserts on (spaceId, key), so saving would
  // silently overwrite the existing memory's content/tags. Surface it explicitly.
  const duplicateKey = !isEditing && trimmedKey !== '' && existingKeys.includes(trimmedKey);

  const handleSave = async () => {
    setError(null);

    const trimmedContent = content.trim();
    const tags = parseTagsInput(tagsInput);

    if (!isEditing && !trimmedKey) {
      setError('Key is required.');
      return;
    }
    if (!trimmedContent) {
      setError('Content is required.');
      return;
    }
    const oversizedTag = tags.find((tag) => tag.length > TAG_MAX_LENGTH);
    if (oversizedTag) {
      setError(`Tags must be ${TAG_MAX_LENGTH} characters or fewer.`);
      return;
    }

    setSaving(true);
    try {
      const entry = await memoryStore.write({
        key: trimmedKey,
        content: trimmedContent,
        tags,
      });
      toast.success(`Memory "${entry.key}" saved`);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save memory';
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={isEditing ? 'Edit Memory' : 'New Memory'} size="md">
      <div class="space-y-4">
        <div>
          <label class="mb-1 block text-xs font-medium text-gray-300" htmlFor="memory-key">
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
            class="w-full rounded-lg border border-white/10 bg-dark-950 px-3 py-2 font-mono text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-60"
            data-testid="memory-key-input"
          />
          <p class="mt-1 text-xs text-gray-600">
            {isEditing
              ? 'Key cannot be changed — delete and recreate to rename.'
              : 'A short, unique identifier for this memory within the space.'}
          </p>
          {duplicateKey && (
            <p class="mt-1 text-xs text-amber-300" data-testid="memory-duplicate-key-warning">
              A memory with this key already exists — saving will overwrite its content and tags.
            </p>
          )}
        </div>

        <div>
          <label class="mb-1 block text-xs font-medium text-gray-300" htmlFor="memory-content">
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
            class="w-full resize-y rounded-lg border border-white/10 bg-dark-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
            data-testid="memory-content-input"
          />
          <p class="mt-1 text-right text-xs text-gray-600">
            {content.length}/{CONTENT_MAX_LENGTH}
          </p>
        </div>

        <div>
          <label class="mb-1 block text-xs font-medium text-gray-300" htmlFor="memory-tags">
            Tags
          </label>
          <input
            id="memory-tags"
            type="text"
            value={tagsInput}
            onInput={(e) => setTagsInput((e.target as HTMLInputElement).value)}
            disabled={saving}
            placeholder="convention, feedback, project"
            class="w-full rounded-lg border border-white/10 bg-dark-950 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
            data-testid="memory-tags-input"
          />
          <p class="mt-1 text-xs text-gray-600">Comma-separated keywords that improve retrieval.</p>
        </div>

        {error && (
          <p
            class="rounded-lg border border-red-800/50 bg-red-900/20 px-3 py-2 text-sm text-red-400"
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
            {isEditing ? 'Save Changes' : duplicateKey ? 'Overwrite Memory' : 'Create Memory'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
