import { useEffect, useRef, useState } from 'preact/hooks';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { neoProjectMoveReason, neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import { mutateNeoProjectTree } from './project-tree-client.ts';

export function NeoProjectTree({
  projects,
  refresh,
}: {
  projects: readonly NeoProject[];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [parent, setParent] = useState('');
  const [epic, setEpic] = useState('');
  const live = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const path = (id: string) =>
    neoProjectPath(projects, id)
      .map((project) => project.title)
      .join(' › ');
  async function change(action: 'neo.project.move' | 'neo.project.section', input: unknown) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await mutateNeoProjectTree(action, input, refresh);
      if (!result.ok && live.current) setError(result.reason);
    } catch (cause) {
      if (live.current)
        setError(cause instanceof Error ? cause.message : 'Could not update projects.');
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <div class="relative">
      <button
        type="button"
        class="neo-float-link"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Projects
      </button>
      {open && (
        <section
          aria-label="Project hierarchy"
          class="absolute left-0 top-full z-30 mt-3 max-h-[70vh] w-80 max-w-[85vw] overflow-y-auto rounded-xl border border-line bg-surface p-4 shadow-lg"
        >
          <h2 class="mb-3 font-medium">Your projects</h2>
          {!projects.length && <p class="text-sm text-fg-muted">No projects yet.</p>}
          <ul class="space-y-4">
            {projects
              .filter((project) => project.id !== 'inbox')
              .map((project) => (
                <li key={project.id}>
                  <p class="break-words text-sm" aria-label={`Path for ${project.title}`}>
                    {path(project.id)}
                  </p>
                  {project.epicUrl && (
                    <a
                      class="text-xs text-accent"
                      href={project.epicUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Epic ↗
                    </a>
                  )}
                  <label class="mt-1 block text-xs text-fg-muted">
                    Move {project.title} under
                    <select
                      class="mt-1 w-full rounded border border-line bg-surface p-2 text-fg"
                      disabled={busy}
                      value={project.parentId ?? ''}
                      onChange={(event) =>
                        void change('neo.project.move', {
                          id: project.id,
                          parentId: event.currentTarget.value || null,
                          expectedRevision: project.revision,
                        })
                      }
                    >
                      {!project.epicUrl && <option value="">Neo (top level)</option>}
                      {projects
                        .filter(
                          (candidate) => !neoProjectMoveReason(projects, project.id, candidate.id)
                        )
                        .map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {path(candidate.id)}
                          </option>
                        ))}
                    </select>
                  </label>
                </li>
              ))}
          </ul>
          <form
            class="mt-5 space-y-2 border-t border-line pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void change('neo.project.section', { parentId: parent, epicUrl: epic.trim() });
            }}
          >
            <h3 class="text-sm font-medium">Add a section from an epic</h3>
            <label class="block text-xs">
              Parent project
              <select
                required
                disabled={busy}
                value={parent}
                onChange={(event) => setParent(event.currentTarget.value)}
                class="mt-1 w-full rounded border border-line bg-surface p-2"
              >
                <option value="">Choose a project</option>
                {projects
                  .filter((project) => project.id !== 'inbox')
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {path(project.id)}
                    </option>
                  ))}
              </select>
            </label>
            <label class="block text-xs">
              GitHub epic URL
              <input
                required
                type="url"
                disabled={busy}
                value={epic}
                onInput={(event) => setEpic(event.currentTarget.value)}
                class="mt-1 w-full rounded border border-line bg-surface p-2"
              />
            </label>
            <button
              type="submit"
              disabled={busy || !parent || !epic.trim()}
              class="rounded bg-accent px-3 py-2 text-sm text-accent-fg"
            >
              Add section
            </button>
          </form>
          {error && (
            <p role="alert" class="mt-3 text-sm text-fg">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
