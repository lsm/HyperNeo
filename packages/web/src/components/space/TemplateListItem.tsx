import type { SpaceLongHorizonAgentTemplate } from '@hyperneo/shared';

export function TemplateListItem({
  template,
  isUserTemplate,
  onEdit,
  onDelete,
  onClone,
}: {
  template: SpaceLongHorizonAgentTemplate;
  isUserTemplate: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onClone?: () => void;
}) {
  return (
    <div class="group flex items-start justify-between gap-4 px-4 py-3.5 transition-colors">
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <h3 class="truncate text-sm font-medium text-fg-soft">{template.displayName}</h3>
          {!isUserTemplate && (
            <span class="inline-flex shrink-0 items-center rounded border border-line px-1.5 py-0.5 text-xs text-fg-muted">
              Built-in
            </span>
          )}
        </div>
        {template.description && (
          <p class="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">{template.description}</p>
        )}
      </div>
      {(onEdit || onDelete || onClone) && (
        <div class="flex flex-shrink-0 items-center gap-1.5 opacity-70 transition-opacity group-hover:opacity-100">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              aria-label={`Edit template ${template.displayName}`}
              class="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg-soft"
            >
              Edit
            </button>
          )}
          {onClone && (
            <button
              type="button"
              onClick={onClone}
              aria-label={`Clone template ${template.displayName}`}
              class="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-fg-soft"
            >
              Clone
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete template ${template.displayName}`}
              title="Delete template"
              class="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-fill-soft hover:text-danger"
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
          )}
        </div>
      )}
    </div>
  );
}
