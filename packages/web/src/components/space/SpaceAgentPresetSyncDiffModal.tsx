import { useEffect, useState } from 'preact/hooks';
import type { SpaceWorkerAgent, SpaceWorkerAgentSyncPreview } from '@hyperneo/shared';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';

interface Props {
  agent: SpaceWorkerAgent;
  onClose: () => void;
  onSynced: (agent: SpaceWorkerAgent) => void;
}

function hasDiff(preview: SpaceWorkerAgentSyncPreview): boolean {
  return Boolean(preview.diff.customPrompt || preview.diff.description || preview.diff.tools);
}

export function SpaceAgentPresetSyncDiffModal({ agent, onClose, onSynced }: Props) {
  const [preview, setPreview] = useState<SpaceWorkerAgentSyncPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

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

  const handleApply = async () => {
    setApplying(true);
    try {
      const updated = await spaceStore.syncAgentFromTemplate(agent.id, preview?.rowHash);
      toast.success(`"${agent.name}" updated from template`);
      onSynced(updated);
      onClose();
    } catch (err) {
      toast.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApplying(false);
    }
  };

  const loading = !preview && !loadError;

  return (
    <Modal isOpen onClose={onClose} title={`Review update — ${agent.name}`} size="lg">
      <div class="space-y-4">
        <p class="text-xs text-fg-faint">
          {agent.templateName
            ? `A newer version of the "${agent.templateName}" template is available. Review what applying the update would change, then apply it.`
            : preview?.templateName
              ? `This agent lost preset tracking. Review what re-attaching it to the "${preview.templateName}" preset would change, then apply.`
              : 'This worker agent is not linked to a template.'}
        </p>

        {loading && <p class="text-xs text-fg-faint animate-pulse">Loading diff...</p>}

        {loadError && <p class="text-xs text-danger">Failed to load diff: {loadError}</p>}

        {preview && !hasDiff(preview) && (
          <p class="rounded-md border border-line bg-white/[0.03] px-3 py-2 text-xs text-fg-muted">
            Fields already match the template. Applying only re-stamps the version (
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
      <p class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-muted">{label}</p>
      {children}
    </div>
  );
}

function BeforeAfter({ before, after }: { before: string; after: string }) {
  return (
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div>
        <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-danger-soft/80">
          Before
        </p>
        <pre class="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-scrim p-2 text-xs leading-5 text-fg-soft">
          {before || '(empty)'}
        </pre>
      </div>
      <div>
        <p class="mb-1 text-[10px] font-medium uppercase tracking-wider text-success-soft/80">
          After
        </p>
        <pre class="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-scrim p-2 text-xs leading-5 text-fg-soft">
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
        <span class="text-[10px] font-medium uppercase tracking-wider text-success-soft/80">
          Added:
        </span>
        {diff.added.length === 0 ? (
          <span class="text-xs text-fg-faint">none</span>
        ) : (
          diff.added.map((tool) => (
            <span
              key={`add-${tool}`}
              class="rounded border border-success/30 bg-success/10 px-1.5 py-0.5 text-xs text-success-soft"
            >
              {tool}
            </span>
          ))
        )}
      </div>
      <div class="flex flex-wrap gap-1.5">
        <span class="text-[10px] font-medium uppercase tracking-wider text-danger-soft/80">
          Removed:
        </span>
        {diff.removed.length === 0 ? (
          <span class="text-xs text-fg-faint">none</span>
        ) : (
          diff.removed.map((tool) => (
            <span
              key={`rm-${tool}`}
              class="rounded border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-xs text-danger-soft"
            >
              {tool}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
