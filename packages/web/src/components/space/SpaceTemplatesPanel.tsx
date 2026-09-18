import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { groupTemplatesByLabel } from './template-grouping';
import { TemplateListItem } from './TemplateListItem';
import { TemplateDeleteDialog } from './TemplateDeleteDialog';
import { TemplateEditor } from './TemplateEditor';
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
  onUseTemplate,
}: {
  spaceId: string;
  templates: SpaceLongHorizonAgentTemplate[];
  userTemplateKeys: ReadonlySet<string>;
  onUseTemplate: (template: SpaceLongHorizonAgentTemplate) => void;
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

  return (
    <>
      <section>
        <div class="mb-2 flex items-end justify-between gap-3">
          <div>
            <h3 class="text-sm font-semibold tracking-tight text-fg-soft">
              Templates · <span data-testid="agent-template-count">{templates.length}</span>
            </h3>
            <p class="mt-0.5 text-xs text-fg-faint">
              Add a focused role with preconfigured instructions.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditingTemplate(null);
              setShowTemplateEditor(true);
            }}
            class="text-xs font-medium text-accent-soft/85 underline-offset-4 transition-colors hover:text-accent-soft hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            New Template
          </button>
        </div>
        <div
          class={`divide-y divide-line overflow-hidden rounded-xl bg-surface-overlay/60 ${templateGroups.length > 0 ? 'border border-line' : ''}`}
        >
          {templateGroups.map((group) => (
            <div key={group.key} data-testid={`agent-template-group-${group.key}`}>
              <h4 class="border-b border-line bg-fill-soft/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint">
                {group.title} · {group.templates.length}
              </h4>
              <div class="divide-y divide-line/60">
                {group.templates.map((t) => (
                  <TemplateListItem
                    key={t.key}
                    template={t}
                    isUserTemplate={userTemplateKeys.has(t.key)}
                    onClick={() => onUseTemplate(t)}
                    onEdit={() => {
                      setEditingTemplate(t);
                      setShowTemplateEditor(true);
                    }}
                    onDelete={() => openTemplateDelete(spaceId, t)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {showTemplateEditor && (
        <TemplateEditor
          template={editingTemplate}
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
