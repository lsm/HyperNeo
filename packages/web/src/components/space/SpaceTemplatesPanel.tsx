import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { groupTemplatesByLabel } from './template-grouping';
import { TemplateListItem } from './TemplateListItem';
import { TemplateDeleteDialog } from './TemplateDeleteDialog';
import { TemplateEditor } from './TemplateEditor';
import { Button } from '../ui/Button';
import { toast } from '../../lib/toast';
import {
  abandonIdleTemplateDelete,
  closeTemplateDelete,
  openTemplateDelete,
  openTemplateHide,
  runTemplateDelete,
  templateDeleteRequest,
} from './template-delete-request';

export function SpaceTemplatesPanel({
  spaceId,
  templates,
  userTemplateKeys,
  builtInTemplateKeys,
  hiddenBuiltIns,
}: {
  spaceId: string;
  templates: SpaceLongHorizonAgentTemplate[];
  userTemplateKeys: ReadonlySet<string>;
  builtInTemplateKeys: ReadonlySet<string>;
  hiddenBuiltIns: SpaceLongHorizonAgentTemplate[];
}) {
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SpaceLongHorizonAgentTemplate | null>(
    null
  );
  const templateGroups = groupTemplatesByLabel(templates);
  const pendingDelete = templateDeleteRequest.value;

  useEffect(() => {
    return () => abandonIdleTemplateDelete(spaceId);
  }, [spaceId]);

  const openNewTemplate = () => {
    setEditingTemplate(null);
    setShowTemplateEditor(true);
  };

  const openEditTemplate = (template: SpaceLongHorizonAgentTemplate) => {
    setEditingTemplate(template);
    setShowTemplateEditor(true);
  };

  const restoreHiddenTemplate = async (template: SpaceLongHorizonAgentTemplate) => {
    try {
      await spaceStore.unhideBuiltInTemplate(template.key);
      toast.success(`"${template.displayName}" restored`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to restore template';
      toast.error(`Could not restore "${template.displayName}": ${message}`);
    }
  };

  return (
    <>
      <div data-testid="space-templates-panel">
        <div class="st-sec-head">
          <div class="min-w-0">
            <h3 class="st-sec-title">
              Agent Templates ·{' '}
              <span data-testid="agent-template-count" class="text-fg-muted">
                {templates.length}
              </span>
            </h3>
            <p class="st-sec-desc">
              Reusable role presets — instructions, autonomy, model, and tools in one place. Agents
              created from a template inherit its configuration.
            </p>
          </div>
          <div class="st-sec-actions">
            <Button
              type="button"
              size="sm"
              onClick={openNewTemplate}
              data-testid="new-template-button"
            >
              + New Template
            </Button>
          </div>
        </div>

        {templates.length === 0 ? (
          <div class="st-group">
            <div class="st-empty">
              <p class="st-empty-title">No templates yet</p>
              <p class="st-empty-desc">
                Create a template to give agents a repeatable starting configuration.
              </p>
              <div class="mt-4">
                <Button type="button" size="sm" onClick={openNewTemplate}>
                  Create your first template
                </Button>
              </div>
            </div>
          </div>
        ) : (
          templateGroups.map((group) => (
            <div key={group.key} data-testid={`agent-template-group-${group.key}`}>
              <div class="st-group-cap">
                {group.title} · {group.templates.length}
              </div>
              <div class="st-group">
                {group.templates.map((t) => (
                  <TemplateListItem
                    key={t.key}
                    template={t}
                    isBuiltIn={builtInTemplateKeys.has(t.key)}
                    isUserTemplate={userTemplateKeys.has(t.key)}
                    onEdit={() => openEditTemplate(t)}
                    onDelete={
                      userTemplateKeys.has(t.key)
                        ? () => openTemplateDelete(spaceId, t)
                        : () => openTemplateHide(spaceId, t)
                    }
                  />
                ))}
              </div>
            </div>
          ))
        )}

        {hiddenBuiltIns.length > 0 && (
          <div data-testid="agent-template-group-hidden">
            <div class="st-group-cap">Hidden · {hiddenBuiltIns.length}</div>
            <div class="st-group">
              {hiddenBuiltIns.map((t) => (
                <div key={t.key} class="st-trow">
                  <div class="st-trow-body">
                    <div class="flex min-w-0 items-center gap-2">
                      <span class="st-trow-name truncate">{t.displayName}</span>
                      <span class="st-chip">Built-in</span>
                    </div>
                    {t.description && (
                      <p class="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">
                        {t.description}
                      </p>
                    )}
                  </div>
                  <span class="st-trow-acts">
                    <button
                      type="button"
                      onClick={() => void restoreHiddenTemplate(t)}
                      aria-label={`Restore template ${t.displayName}`}
                      class="st-act"
                    >
                      Restore
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {showTemplateEditor && (
        <TemplateEditor
          template={editingTemplate}
          copyFromOptions={templates}
          onSaved={() => {
            setShowTemplateEditor(false);
            setEditingTemplate(null);
          }}
          onCancel={() => {
            setShowTemplateEditor(false);
            setEditingTemplate(null);
          }}
        />
      )}

      {pendingDelete && pendingDelete.spaceId === spaceId && (
        <TemplateDeleteDialog
          template={pendingDelete.template}
          hidesBuiltIn={pendingDelete.hidesBuiltIn}
          restoresBuiltIn={
            !pendingDelete.hidesBuiltIn && builtInTemplateKeys.has(pendingDelete.template.key)
          }
          busy={pendingDelete.busy}
          error={pendingDelete.error}
          onConfirm={runTemplateDelete}
          onClose={closeTemplateDelete}
        />
      )}
    </>
  );
}

export function SpaceTemplatesSection({ spaceId }: { spaceId: string }) {
  const templates = spaceStore.agentTemplates.value;
  const userTemplateKeys = spaceStore.userTemplateKeys.value;
  const builtInTemplateKeys = spaceStore.builtInTemplateKeys.value;
  const hiddenBuiltIns = spaceStore.hiddenBuiltInTemplates.value;

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [spaceId]);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden pt-4">
      <SpaceTemplatesPanel
        spaceId={spaceId}
        templates={templates}
        userTemplateKeys={userTemplateKeys}
        builtInTemplateKeys={builtInTemplateKeys}
        hiddenBuiltIns={hiddenBuiltIns}
      />
    </div>
  );
}
