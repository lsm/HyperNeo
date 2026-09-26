import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { groupTemplatesByLabel } from './template-grouping';
import { TemplateListItem } from './TemplateListItem';
import { TemplateDeleteDialog } from './TemplateDeleteDialog';
import { TemplateEditor } from './TemplateEditor';
import { Button } from '../ui/Button';
import {
  abandonIdleTemplateDelete,
  closeTemplateDelete,
  openTemplateDelete,
  runTemplateDelete,
  templateDeleteRequest,
} from './template-delete-request';

export function SpaceTemplatesPanel({
  spaceId,
  templates,
  userTemplateKeys,
}: {
  spaceId: string;
  templates: SpaceLongHorizonAgentTemplate[];
  userTemplateKeys: ReadonlySet<string>;
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
                    isUserTemplate={userTemplateKeys.has(t.key)}
                    onEdit={userTemplateKeys.has(t.key) ? () => openEditTemplate(t) : undefined}
                    onDelete={
                      userTemplateKeys.has(t.key) ? () => openTemplateDelete(spaceId, t) : undefined
                    }
                  />
                ))}
              </div>
            </div>
          ))
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

  useEffect(() => {
    spaceStore.ensureConfigData().catch(() => {});
  }, [spaceId]);

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden pt-4">
      <SpaceTemplatesPanel
        spaceId={spaceId}
        templates={templates}
        userTemplateKeys={userTemplateKeys}
      />
    </div>
  );
}
