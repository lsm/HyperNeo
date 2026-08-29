import { useState, useEffect } from 'preact/hooks';
import type {
  SpaceWorkflowSummary,
  SpaceExportBundle,
  DuplicateDriftReport,
} from '@hyperneo/shared';
import { spaceStore } from '../../lib/space-store';

type WorkflowConditionType = 'always' | 'human' | 'condition' | 'task_result';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { ImportPreviewDialog } from './ImportPreviewDialog.tsx';
import type { ImportPreviewResult, ImportConflictResolution } from './ImportPreviewDialog.tsx';
import { downloadBundle, pickImportFile } from './export-import-utils.ts';
import { WorkflowTemplateSyncDiffModal } from './WorkflowTemplateSyncDiffModal.tsx';

const GATE_COLORS: Record<WorkflowConditionType, string> = {
  always: 'bg-accent',
  human: 'bg-warning',
  condition: 'bg-cat-purple',
  task_result: 'bg-warning',
};

function MiniStepDot({ isStart }: { isStart: boolean }) {
  return (
    <span
      class={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isStart ? 'bg-accent' : 'bg-accent-soft'}`}
    />
  );
}

function MiniConnector({ conditionType }: { conditionType?: WorkflowConditionType }) {
  const color = conditionType ? GATE_COLORS[conditionType] : 'bg-fill-strong';
  return (
    <div class="flex items-center gap-0.5 flex-shrink-0">
      <div class="w-4 h-px bg-fill-strong" />
      {conditionType && conditionType !== 'always' && (
        <span class={`w-1.5 h-1.5 rounded-full ${color}`} />
      )}
      <div class="w-4 h-px bg-fill-strong" />
    </div>
  );
}

const MAX_DOTS = 6;

function MiniStepViz({ workflow }: { workflow: SpaceWorkflowSummary }) {
  if (workflow.nodeCount === 0) {
    return <span class="text-xs text-fg-muted italic">No steps</span>;
  }

  const overflow = workflow.nodeCount > MAX_DOTS ? workflow.nodeCount - MAX_DOTS : 0;
  const display = overflow > 0 ? workflow.nodeCount - overflow : workflow.nodeCount;

  return (
    <div class="flex items-center gap-0 overflow-hidden">
      {Array.from({ length: display }).map((_, i) => (
        <div key={i} class="flex items-center">
          <MiniStepDot isStart={i === 0} />
          {i + 1 < display && <MiniConnector conditionType={undefined} />}
        </div>
      ))}
      {overflow > 0 && <span class="text-xs text-fg-muted ml-1">+{overflow}</span>}
    </div>
  );
}

interface DuplicateDriftInfo {
  templateName: string;
  groupSize: number;
  isNewest: boolean;
}

interface WorkflowCardProps {
  workflow: SpaceWorkflowSummary;
  spaceId: string;
  spaceName: string;
  onEdit: () => void;
  duplicateDrift?: DuplicateDriftInfo;
  onResyncDuplicates?: (templateName: string) => Promise<void>;
}

function WorkflowCard({
  workflow,
  spaceId,
  spaceName,
  onEdit,
  duplicateDrift,
  onResyncDuplicates,
}: WorkflowCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [driftState, setDriftState] = useState<{
    updateAvailable: boolean;
    customized: boolean;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmSync, setConfirmSync] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const [confirmDupResync, setConfirmDupResync] = useState(false);
  const [dupResyncing, setDupResyncing] = useState(false);
  const [dupResyncError, setDupResyncError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflow.templateName) return;

    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;

    let cancelled = false;
    hub
      .request<{ updateAvailable: boolean; customized: boolean }>('spaceWorkflow.detectDrift', {
        id: workflow.id,
        spaceId,
      })
      .then((result) => {
        if (!cancelled)
          setDriftState({
            updateAvailable: result.updateAvailable,
            customized: result.customized,
          });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [workflow.id, workflow.updatedAt, workflow.templateName, spaceId]);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await spaceStore.deleteWorkflow(workflow.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete workflow.');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  async function handleExport() {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Connection lost.');
      return;
    }
    try {
      const { bundle } = await hub.request<{ bundle: SpaceExportBundle }>('spaceExport.workflows', {
        spaceId,
        workflowIds: [workflow.id],
      });
      downloadBundle(bundle, spaceName, 'workflows');
      toast.success(`Exported "${workflow.name}"`);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleSyncFromTemplate() {
    setSyncing(true);
    setSyncError(null);
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Not connected');
      await hub.request('spaceWorkflow.syncFromTemplate', {
        id: workflow.id,
        spaceId,
      });
      setConfirmSync(false);
      setDriftState({ updateAvailable: false, customized: false });
      toast.success(`"${workflow.name}" updated from template`);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSyncing(false);
    }
  }

  async function handleResyncDuplicates() {
    if (!duplicateDrift || !onResyncDuplicates) return;
    setDupResyncing(true);
    setDupResyncError(null);
    try {
      await onResyncDuplicates(duplicateDrift.templateName);
      setConfirmDupResync(false);
    } catch (err) {
      setDupResyncError(err instanceof Error ? err.message : 'Resync failed');
    } finally {
      setDupResyncing(false);
    }
  }

  return (
    <div
      class={[
        'group border-b border-line py-3 transition-colors last:border-b-0',
        workflow.disabled ? 'opacity-60' : '',
      ].join(' ')}
    >
      {deleteError && (
        <div class="mb-2 rounded bg-danger/20 px-3 py-1.5 text-xs text-danger-soft">
          {deleteError}
        </div>
      )}

      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-2">
            <h3 class="text-sm font-medium text-fg-soft truncate">{workflow.name}</h3>
            {workflow.disabled && (
              <span class="inline-flex shrink-0 items-center rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                Disabled
              </span>
            )}
          </div>
          {workflow.description && (
            <p class="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{workflow.description}</p>
          )}
          {workflow.templateName && (
            <div class="mt-1.5 flex items-center gap-1.5">
              <span class="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">
                {workflow.templateName}
              </span>
              {driftState?.updateAvailable && (
                <span
                  class="inline-flex items-center rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning"
                  title="A newer version of this template is available. Apply it to bring this workflow up to date."
                >
                  Update available
                </span>
              )}
              {driftState?.customized && (
                <span
                  class="inline-flex items-center rounded bg-fill-soft px-1.5 py-0.5 text-xs text-fg-muted"
                  title={
                    driftState?.updateAvailable
                      ? 'This workflow has local edits on top of its template — review the diff before applying the update.'
                      : "You've customized this workflow from its template. No action needed."
                  }
                >
                  Customized
                </span>
              )}
              {duplicateDrift && (
                <span
                  class="inline-flex items-center rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning-soft"
                  title={`${duplicateDrift.groupSize} rows share the "${duplicateDrift.templateName}" template (duplicates). Resync keeps the newest row and removes the rest.`}
                >
                  Duplicate ×{duplicateDrift.groupSize}
                </span>
              )}
            </div>
          )}
        </div>

        <div
          data-testid="workflow-card-actions"
          class="flex flex-shrink-0 items-center gap-1.5 opacity-70 transition-opacity group-hover:opacity-100"
        >
          {confirmDelete ? (
            <>
              <span class="text-xs text-danger">Delete?</span>
              <button
                onClick={handleDelete}
                disabled={deleting}
                class="px-2 py-1 text-xs text-danger-soft bg-danger/30 hover:bg-danger/50 border border-danger/50 rounded disabled:opacity-50 transition-colors"
              >
                {deleting ? '…' : 'Confirm'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                class="px-2 py-1 text-xs text-fg-muted hover:text-fg-soft transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {workflow.templateName &&
                driftState?.updateAvailable &&
                (driftState.customized ? (
                  <button
                    onClick={() => setDiffOpen(true)}
                    class="rounded-md px-2 py-1 text-xs text-warning transition-colors hover:bg-fill-soft hover:text-warning-soft"
                    title="This workflow has local edits. Review the diff before applying the template update."
                  >
                    Review diff
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmSync(true)}
                    class="rounded-md px-2 py-1 text-xs text-warning transition-colors hover:bg-fill-soft hover:text-warning-soft"
                    title="Apply the template update (no local edits to lose)"
                  >
                    Apply update
                  </button>
                ))}
              {duplicateDrift?.isNewest && (
                <button
                  onClick={() => setConfirmDupResync(true)}
                  class="rounded-md px-2 py-1 text-xs text-warning-soft transition-colors hover:bg-fill-soft hover:text-warning-soft"
                  title={`Remove ${duplicateDrift.groupSize - 1} older duplicate${duplicateDrift.groupSize - 1 === 1 ? '' : 's'} and resync this workflow from the built-in template`}
                >
                  Resync duplicates
                </button>
              )}
              <button
                onClick={onEdit}
                class="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg-soft"
              >
                Edit
              </button>
              <button
                onClick={handleExport}
                class="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg-soft"
                title="Export workflow"
              >
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                class="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-danger"
                title="Delete workflow"
              >
                <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <span class="text-xs text-fg-muted">
          {workflow.nodeCount} {workflow.nodeCount === 1 ? 'step' : 'steps'}
        </span>
        <MiniStepViz workflow={workflow} />
        {workflow.tags.length > 0 && (
          <>
            <span class="text-fg-muted">·</span>
            {workflow.tags.map((tag) => (
              <span
                key={tag}
                class="rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted"
              >
                {tag}
              </span>
            ))}
          </>
        )}
      </div>

      {confirmDupResync && duplicateDrift && (
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim">
          <div class="bg-surface-overlay border border-line rounded-lg p-5 max-w-md w-full shadow-xl">
            <h3 class="text-sm font-semibold text-fg mb-2">Resync duplicate workflows?</h3>
            <p class="text-xs text-fg-muted mb-1">
              This space has{' '}
              <span class="font-medium text-fg-soft">{duplicateDrift.groupSize} rows</span> sharing
              the <span class="font-medium text-fg-soft">"{duplicateDrift.templateName}"</span>{' '}
              template (duplicate rows).
            </p>
            <p class="text-xs text-fg-muted mb-1">
              The newest row <span class="font-medium text-fg-soft">"{workflow.name}"</span> will be
              kept and resynced from the built-in template. The remaining{' '}
              <span class="font-medium text-fg-soft">
                {duplicateDrift.groupSize - 1} older{' '}
                {duplicateDrift.groupSize - 1 === 1 ? 'row' : 'rows'}
              </span>{' '}
              will be deleted.
            </p>
            <p class="text-xs text-danger mb-4">
              Local edits to the older rows and any workflow runs attached to them will be
              permanently lost.
            </p>
            {dupResyncError && (
              <div class="mb-3 px-3 py-1.5 bg-danger/20 border border-danger/40 rounded text-xs text-danger-soft">
                {dupResyncError}
              </div>
            )}
            <div class="flex items-center gap-2 justify-end">
              <button
                onClick={() => {
                  setConfirmDupResync(false);
                  setDupResyncError(null);
                }}
                disabled={dupResyncing}
                class="px-3 py-1.5 text-xs text-fg-muted hover:text-fg-soft transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleResyncDuplicates}
                disabled={dupResyncing}
                class="px-3 py-1.5 text-xs font-medium text-on-warning bg-warning hover:bg-warning rounded transition-colors disabled:opacity-50"
              >
                {dupResyncing ? 'Resyncing…' : 'Delete older rows & resync'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmSync && (
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim">
          <div class="bg-surface-overlay border border-line rounded-lg p-5 max-w-md w-full shadow-xl">
            <h3 class="text-sm font-semibold text-fg mb-2">Apply template update?</h3>
            <p class="text-xs text-fg-muted mb-1">
              This updates <span class="font-medium text-fg-soft">"{workflow.name}"</span> to the
              latest version of the{' '}
              <span class="font-medium text-fg-soft">"{workflow.templateName}"</span> template
              (structure, instructions, and channels).
            </p>
            <p class="text-xs text-fg-faint mb-4">
              No edits were detected to this workflow's steps, instructions, or prompts — though
              applying still overwrites the full structure.
            </p>
            {syncError && (
              <div class="mb-3 px-3 py-1.5 bg-danger/20 border border-danger/40 rounded text-xs text-danger-soft">
                {syncError}
              </div>
            )}
            <div class="flex items-center gap-2 justify-end">
              <button
                onClick={() => {
                  setConfirmSync(false);
                  setSyncError(null);
                }}
                disabled={syncing}
                class="px-3 py-1.5 text-xs text-fg-muted hover:text-fg-soft transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSyncFromTemplate}
                disabled={syncing}
                class="px-3 py-1.5 text-xs font-medium text-accent-fg bg-yellow-700 hover:bg-yellow-600 rounded transition-colors disabled:opacity-50"
              >
                {syncing ? 'Applying…' : 'Apply update'}
              </button>
            </div>
          </div>
        </div>
      )}

      {diffOpen && (
        <WorkflowTemplateSyncDiffModal
          workflow={workflow}
          onClose={() => setDiffOpen(false)}
          onApplied={() => setDriftState({ updateAvailable: false, customized: false })}
        />
      )}
    </div>
  );
}

interface WorkflowListProps {
  spaceId: string;
  spaceName: string;
  workflows: SpaceWorkflowSummary[];
  onCreateWorkflow: () => void;
  onEditWorkflow: (workflowId: string) => void;
}

export function WorkflowList({
  spaceId,
  spaceName,
  workflows,
  onCreateWorkflow,
  onEditWorkflow,
}: WorkflowListProps) {
  const loading = spaceStore.loading.value;
  const [importBundle, setImportBundle] = useState<SpaceExportBundle | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);

  const [duplicateDriftMap, setDuplicateDriftMap] = useState<Map<string, DuplicateDriftInfo>>(
    new Map()
  );

  const driftKey = workflows
    .map((w) => `${w.id}:${w.updatedAt}`)
    .sort()
    .join('|');
  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;

    let cancelled = false;
    hub
      .request<{ reports: DuplicateDriftReport[] }>('spaceWorkflow.detectDuplicateDrift', {
        spaceId,
      })
      .then((result) => {
        if (cancelled) return;
        const map = new Map<string, DuplicateDriftInfo>();
        for (const report of result.reports) {
          for (const [i, row] of report.rows.entries()) {
            map.set(row.id, {
              templateName: report.templateName,
              groupSize: report.rows.length,
              isNewest: i === 0,
            });
          }
        }
        setDuplicateDriftMap(map);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driftKey captures the list identity
  }, [spaceId, driftKey]);

  async function handleResyncDuplicates(templateName: string) {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Connection lost.');
      throw new Error('Not connected');
    }
    const result = await hub.request<{
      deletedIds: string[];
      skippedDueToExecutableRuns?: string[];
    }>('spaceWorkflow.resyncDuplicates', {
      spaceId,
      templateName,
    });
    const removed = result.deletedIds.length;
    const skipped = result.skippedDueToExecutableRuns?.length ?? 0;
    if (skipped > 0) {
      toast.warning(
        `Resynced "${templateName}"${removed > 0 ? ` — removed ${removed} older ${removed === 1 ? 'duplicate' : 'duplicates'}` : ''}; kept ${skipped} ${skipped === 1 ? 'duplicate' : 'duplicates'} with an active run — archive its task(s) and re-sync`
      );
    } else {
      toast.success(
        `Resynced "${templateName}"${removed > 0 ? ` — removed ${removed} older ${removed === 1 ? 'duplicate' : 'duplicates'}` : ''}`
      );
    }
  }

  async function exportAll() {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Connection lost.');
      return;
    }
    try {
      const { bundle } = await hub.request<{ bundle: SpaceExportBundle }>('spaceExport.workflows', {
        spaceId,
      });
      downloadBundle(bundle, spaceName, 'workflows');
      toast.success(`Exported ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function startImport() {
    const bundle = await pickImportFile();
    if (!bundle) return;

    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Connection lost.');
      return;
    }
    try {
      const preview = await hub.request<ImportPreviewResult>('spaceImport.preview', {
        spaceId,
        bundle,
      });
      setImportBundle(bundle);
      setImportPreview(preview);
    } catch (err) {
      toast.error(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function executeImport(resolution: ImportConflictResolution) {
    if (!importBundle) return;
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Connection lost.');
      return;
    }
    setIsExecuting(true);
    try {
      const result = await hub.request<{
        agents: Array<{ name: string; id: string; action: string }>;
        workflows: Array<{ name: string; id: string; action: string }>;
        warnings: string[];
      }>('spaceImport.execute', { spaceId, bundle: importBundle, conflictResolution: resolution });

      const createdWorkflows = result.workflows.filter((w) => w.action !== 'skipped').length;
      toast.success(
        createdWorkflows > 0
          ? `Imported ${createdWorkflows} workflow${createdWorkflows === 1 ? '' : 's'}`
          : 'Nothing imported'
      );
      if (result.warnings.length > 0) {
        toast.warning(result.warnings.join(' · '));
      }
      setImportBundle(null);
      setImportPreview(null);
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExecuting(false);
    }
  }

  if (loading) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center">
          <div class="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="mb-3 flex flex-shrink-0 items-center justify-between gap-3 rounded-lg border border-line bg-fill-soft px-3 py-3">
        <div class="flex min-w-0 items-start gap-3">
          <div class="mt-0.5 h-8 w-1 flex-shrink-0 rounded-full bg-cat-purple/70" />
          <div class="min-w-0">
            <p class="text-xs font-semibold uppercase tracking-wider text-fg-soft">
              {workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'}
            </p>
            <p class="mt-1 text-xs text-fg-muted">Reusable multi-agent pipelines for this space.</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onClick={startImport}
            class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
              />
            </svg>
            Import
          </button>
          {workflows.length > 0 && (
            <button
              type="button"
              onClick={exportAll}
              class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Export All
            </button>
          )}
          <button
            onClick={onCreateWorkflow}
            class="flex items-center gap-1.5 rounded-lg bg-accent-hover px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent"
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Create Workflow
          </button>
        </div>
      </div>

      <div class="scrollbar-dark min-h-0 flex-1 overflow-y-auto pr-3">
        <div class="min-h-[calc(100%+1px)]">
          {workflows.length === 0 ? (
            <div class="text-center py-12">
              <div class="w-10 h-10 mx-auto mb-3 rounded-lg bg-surface-raised border border-line flex items-center justify-center">
                <svg
                  class="w-5 h-5 text-fg-muted"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M4 6h16M4 10h16M4 14h16M4 18h16"
                  />
                </svg>
              </div>
              <p class="text-sm text-fg-muted">No workflows yet</p>
              <p class="text-xs text-fg-muted mt-1">
                Create a workflow to define multi-agent pipelines.
              </p>
              <button
                onClick={onCreateWorkflow}
                class="mt-4 px-4 py-2 text-xs font-medium bg-accent-hover hover:bg-accent text-accent-fg rounded transition-colors"
              >
                Create your first workflow
              </button>
            </div>
          ) : (
            <div>
              {workflows.map((wf) => (
                <WorkflowCard
                  key={wf.id}
                  workflow={wf}
                  spaceId={spaceId}
                  spaceName={spaceName}
                  onEdit={() => onEditWorkflow(wf.id)}
                  duplicateDrift={duplicateDriftMap.get(wf.id)}
                  onResyncDuplicates={handleResyncDuplicates}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {importPreview && importBundle && (
        <ImportPreviewDialog
          key={importBundle.exportedAt}
          isOpen={true}
          onClose={() => {
            setImportBundle(null);
            setImportPreview(null);
          }}
          onConfirm={executeImport}
          preview={importPreview}
          bundle={importBundle}
          isExecuting={isExecuting}
        />
      )}
    </div>
  );
}
