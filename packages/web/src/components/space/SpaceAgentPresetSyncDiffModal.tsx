/**
 * SpaceAgentPresetSyncDiffModal
 *
 * Preview-then-apply modal for resetting a drifted seeded worker agent back to
 * its live preset. Fetches a per-field before/after diff from
 * `spaceAgent.previewTemplateSync` on open, renders the deltas (customPrompt,
 * description, tools), and offers a one-click "Reset to preset" that runs the
 * existing `spaceAgent.syncFromTemplate`.
 *
 * The diff covers exactly the fields sync overwrites, so what the user reviews
 * here is precisely what the reset will change. Never automatic — the reset
 * only fires on an explicit click.
 */

import { useEffect, useState } from 'preact/hooks';
import type { SpaceWorkerAgent, SpaceWorkerAgentSyncPreview } from '@hyperneo/shared';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';

interface Props {
  agent: SpaceWorkerAgent;
  onClose: () => void;
  /** Called with the freshly synced agent after a successful reset. */
  onSynced: (agent: SpaceWorkerAgent) => void;
}

function hasDiff(preview: SpaceWorkerAgentSyncPreview): boolean {
  return Boolean(preview.diff.customPrompt || preview.diff.description || preview.diff.tools);
}

export function SpaceAgentPresetSyncDiffModal({ agent, onClose, onSynced }: Props) {
  const [preview, setPreview] = useState<SpaceWorkerAgentSyncPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setLoadError(null);
    spaceStore
      .previewAgentTemplateSync(agent.id)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const handleReset = async () => {
    setResetting(true);
    try {
      const updated = await spaceStore.syncAgentFromTemplate(agent.id);
      toast.success(`"${agent.name}" reset to preset`);
      onSynced(updated);
      onClose();
    } catch (err) {
      toast.error(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResetting(false);
    }
  };

  const loading = !preview && !loadError;

  return (
    <Modal isOpen onClose={onClose} title={`Preset diff — ${agent.name}`} size="lg">
      <div class="space-y-4">
        <p class="text-xs text-gray-500">
          {agent.templateName
            ? `Seeded from the "${agent.templateName}" preset. Review what resetting to the current preset would change, then apply.`
            : 'This worker agent is not linked to a preset.'}
        </p>

        {loading && <p class="text-xs text-gray-600 animate-pulse">Loading diff...</p>}

        {loadError && <p class="text-xs text-red-400">Failed to load diff: {loadError}</p>}

        {preview && !hasDiff(preview) && (
          <p class="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-gray-400">
            Fields already match the preset. Resetting only re-stamps the version (
            {preview.storedHash ? 'stale' : 'missing'} → current) so the badge clears.
          </p>
        )}

        {preview && preview.diff.customPrompt && (
          <DiffSection label="Custom prompt">
            <BeforeAfter
              before={preview.diff.customPrompt.before}
              after={preview.diff.customPrompt.after}
            />
          </DiffSection>
        )}

        {preview && preview.diff.description && (
          <DiffSection label="Description">
            <BeforeAfter
              before={preview.diff.description.before}
              after={preview.diff.description.after}
            />
          </DiffSection>
        )}

        {preview && preview.diff.tools && (
          <DiffSection label="Tools">
            <ToolsDelta diff={preview.diff.tools} />
          </DiffSection>
        )}

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={resetting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleReset}
            loading={resetting}
            disabled={!preview}
          >
            Reset to preset
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DiffSection({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return (
    <div>
      <p class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400">{label}</p>
      {children}
    </div>
  );
}

function BeforeAfter({ before, after }: { before: string; after: string }) {
  return (
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div>
        <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-red-300/80">Before</p>
        <pre class="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/30 p-2 text-xs leading-5 text-gray-300">
          {before || '(empty)'}
        </pre>
      </div>
      <div>
        <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-emerald-300/80">
          After
        </p>
        <pre class="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/30 p-2 text-xs leading-5 text-gray-300">
          {after || '(empty)'}
        </pre>
      </div>
    </div>
  );
}

function ToolsDelta({
  diff,
}: {
  diff: { before: string[]; after: string[]; added: string[]; removed: string[] };
}) {
  return (
    <div class="space-y-2">
      <div class="flex flex-wrap gap-1.5">
        <span class="text-[10px] font-medium uppercase tracking-wider text-emerald-300/80">
          Added:
        </span>
        {diff.added.length === 0 ? (
          <span class="text-xs text-gray-600">none</span>
        ) : (
          diff.added.map((tool) => (
            <span
              key={`add-${tool}`}
              class="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-300"
            >
              {tool}
            </span>
          ))
        )}
      </div>
      <div class="flex flex-wrap gap-1.5">
        <span class="text-[10px] font-medium uppercase tracking-wider text-red-300/80">
          Removed:
        </span>
        {diff.removed.length === 0 ? (
          <span class="text-xs text-gray-600">none</span>
        ) : (
          diff.removed.map((tool) => (
            <span
              key={`rm-${tool}`}
              class="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-xs text-red-300"
            >
              {tool}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
