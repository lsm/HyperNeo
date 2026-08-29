import { cn } from '../../../lib/utils.ts';

export interface TodoViewerProps {
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }>;
  className?: string;
}

function StatusIcon({ status }: { status: 'pending' | 'in_progress' | 'completed' }) {
  if (status === 'completed') {
    return (
      <svg class="w-5 h-5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    );
  }

  if (status === 'in_progress') {
    return (
      <svg class="w-5 h-5 text-accent animate-spin" fill="none" viewBox="0 0 24 24">
        <circle
          class="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          stroke-width="4"
        ></circle>
        <path
          class="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        ></path>
      </svg>
    );
  }

  return (
    <svg class="w-5 h-5 text-fg-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

export function TodoViewer({ todos, className }: TodoViewerProps) {
  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
  const pendingCount = todos.filter((t) => t.status === 'pending').length;
  const totalCount = todos.length;

  return (
    <div class={cn('rounded-lg overflow-hidden border border-line', className)}>
      <div class="bg-surface-raised px-3 py-2 border-b border-line flex items-center justify-between">
        <div class="text-xs font-semibold text-fg-soft">Task List</div>
        <div class="text-xs px-2 py-0.5 rounded bg-fill-strong text-fg-muted">
          {completedCount}/{totalCount}
        </div>
      </div>

      <div class="bg-surface divide-y divide-line">
        {todos.map((todo, idx) => {
          const bgClass =
            todo.status === 'completed'
              ? 'bg-success/10'
              : todo.status === 'in_progress'
                ? 'bg-accent/10'
                : 'bg-surface';

          const textClass = todo.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg';

          const activeFormClass = 'text-fg-muted italic text-xs mt-1';

          return (
            <div
              key={idx}
              class={cn('px-3 py-3 flex gap-3 items-start transition-colors', bgClass)}
            >
              <div class="flex-shrink-0 mt-0.5">
                <StatusIcon status={todo.status} />
              </div>

              <div class="flex-1 min-w-0">
                <div class={cn('text-sm', textClass)}>{todo.content}</div>
                {todo.status === 'in_progress' && todo.activeForm && (
                  <div class={activeFormClass}>{todo.activeForm}</div>
                )}
              </div>

              <div class="flex-shrink-0">
                {todo.status === 'completed' && (
                  <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/30 text-success">
                    Done
                  </span>
                )}
                {todo.status === 'in_progress' && (
                  <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-accent/15 text-accent-soft">
                    In Progress
                  </span>
                )}
                {todo.status === 'pending' && (
                  <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-surface-raised text-fg-muted">
                    Pending
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div class="bg-surface-raised px-3 py-1.5 border-t border-line flex gap-4 text-xs">
        {completedCount > 0 && (
          <div class="flex items-center gap-1">
            <span class="w-2 h-2 rounded-full bg-success"></span>
            <span class="text-fg-soft">{completedCount} completed</span>
          </div>
        )}
        {inProgressCount > 0 && (
          <div class="flex items-center gap-1">
            <span class="w-2 h-2 rounded-full bg-accent-hover"></span>
            <span class="text-fg-soft">{inProgressCount} in progress</span>
          </div>
        )}
        {pendingCount > 0 && (
          <div class="flex items-center gap-1">
            <span class="w-2 h-2 rounded-full bg-fg-muted"></span>
            <span class="text-fg-soft">{pendingCount} pending</span>
          </div>
        )}
      </div>
    </div>
  );
}
