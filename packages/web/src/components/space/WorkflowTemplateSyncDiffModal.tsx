/**
 * WorkflowTemplateSyncDiffModal
 *
 * Preview-then-apply modal for applying a template update to a seeded
 * workflow. Fetches a structural before/after diff from
 * `spaceWorkflow.previewTemplateSync` on open, renders the deltas
 * (description, instructions, node set), and offers a one-click "Apply update"
 * that runs the existing `spaceWorkflow.syncFromTemplate`.
 *
 * This is the REQUIRED review path when the workflow is both customized and
 * has an update available — applying a structural update would otherwise
 * silently discard the local edits. The apply is never automatic; it only
 * fires on an explicit click.
 */

import { useEffect, useState } from 'preact/hooks';
import type { SpaceWorkflowSummary, SpaceWorkflowSyncPreview } from '@hyperneo/shared';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';

interface Props {
  workflow: SpaceWorkflowSummary;
  onClose: () => void;
  /** Called after a successful apply, before the modal closes. */
  onApplied: () => void;
}

function hasDiff(preview: SpaceWorkflowSyncPreview): boolean {
  return Boolean(preview.diff.description || preview.diff.instructions || preview.diff.nodes);
}

export function WorkflowTemplateSyncDiffModal({ workflow, onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<SpaceWorkflowSyncPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setLoadError(null);
    spaceStore
      .previewWorkflowTemplateSync(workflow.id)
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
  }, [workflow.id]);

  const handleApply = async () => {
    setApplying(true);
    try {
      await spaceStore.syncWorkflowFromTemplate(workflow.id);
      toast.success(`"${workflow.name}" updated from template`);
      onApplied();
      onClose();
    } catch (err) {
      toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApplying(false);
    }
  };

  const loading = !preview && !loadError;

  return (
    <Modal isOpen onClose={onClose} title={`Review update — ${workflow.name}`} size="lg">
      <div class="space-y-4">
        <p class="text-xs text-gray-500">
          A newer version of the "{workflow.templateName}" template is available. Review what
          applying the update would change, then apply it.{' '}
          {preview?.customized && (
            <span class="text-amber-300/90">
              This workflow has local edits — they will be overwritten.
            </span>
          )}
        </p>

        {loading && <p class="text-xs text-gray-600 animate-pulse">Loading diff...</p>}

        {loadError && <p class="text-xs text-red-400">Failed to load diff: {loadError}</p>}

        {preview && !hasDiff(preview) && (
          <p class="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-gray-400">
            The listed structure already matches the template. Applying re-syncs the full structure
            and re-stamps the version ({preview.storedHash ? 'stale' : 'missing'} → current) so the
            badge clears.
          </p>
        )}

        {preview && preview.diff.description && (
          <DiffSection label="Description">
            <BeforeAfter
              before={preview.diff.description.before}
              after={preview.diff.description.after}
            />
          </DiffSection>
        )}

        {preview && preview.diff.instructions && (
          <DiffSection label="Instructions">
            <BeforeAfter
              before={preview.diff.instructions.before}
              after={preview.diff.instructions.after}
            />
          </DiffSection>
        )}

        {preview && preview.diff.nodes && (
          <DiffSection label="Steps">
            <NameDelta diff={preview.diff.nodes} singular="step" />
          </DiffSection>
        )}

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            loading={applying}
            disabled={!preview}
          >
            Apply update
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

function NameDelta({
  diff,
  singular,
}: {
  diff: { added: string[]; removed: string[] };
  singular: string;
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
          diff.added.map((name) => (
            <span
              key={`add-${name}`}
              class="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-300"
            >
              {name}
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
          diff.removed.map((name) => (
            <span
              key={`rm-${name}`}
              class="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-xs text-red-300"
            >
              {name}
            </span>
          ))
        )}
      </div>
      <p class="text-[10px] text-gray-600">
        Ordering and {singular} details are reconciled on apply.
      </p>
    </div>
  );
}
