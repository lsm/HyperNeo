import type { EvolutionScope, EvolutionLesson } from '@hyperneo/shared';
import { useMessageHub } from '../../hooks/useMessageHub';
import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { Button } from '../ui/Button';

export function ActiveLessonsTab({ scope }: { scope: EvolutionScope }) {
  const { request } = useMessageHub();
  const [lessons, setLessons] = useState<EvolutionLesson[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const loadLessons = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    try {
      const response = await request<{ lessons: EvolutionLesson[] }>('evolution.lesson.list', {
        scopeId: scope.id,
        status: 'active',
      });
      if (requestVersion.current === version) setLessons(response.lessons ?? []);
    } catch (err) {
      if (requestVersion.current === version) {
        setError(err instanceof Error ? err.message : 'Failed to load active lessons');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [request, scope.id]);

  useEffect(() => {
    loadLessons().catch(() => undefined);
  }, [loadLessons]);

  const dismissLesson = async (lessonId: string) => {
    try {
      setError(null);
      const response = await request<{ lesson: EvolutionLesson | null }>(
        'evolution.lesson.update',
        {
          id: lessonId,
          params: { status: 'dismissed' },
        }
      );
      if (response.lesson) setLessons((current) => current.filter((item) => item.id !== lessonId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss lesson');
    }
  };

  return (
    <section class="rounded-xl border border-line bg-fill-soft p-4">
      <div class="mb-3">
        <h3 class="text-sm font-medium text-fg">Active lessons</h3>
        <p class="mt-1 text-xs text-fg-muted">
          Top active lessons from this scope are injected into future scoped task-agent messages.
        </p>
      </div>
      {error && (
        <div class="mb-3 rounded-lg border border-danger bg-danger/20 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      {loading ? (
        <p class="text-sm text-fg-muted">Loading active lessons…</p>
      ) : lessons.length === 0 ? (
        <p class="text-sm text-fg-muted">No active lessons yet.</p>
      ) : (
        <div class="space-y-3">
          {lessons.map((lesson) => (
            <div key={lesson.id} class="rounded-lg border border-line bg-surface/60 p-3">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-sm text-fg">{lesson.rule}</p>
                  <p class="mt-1 text-xs text-fg-muted">{lesson.why}</p>
                  {lesson.appliesTo.length > 0 && (
                    <p class="mt-2 text-xs text-info-soft">
                      Applies to: {lesson.appliesTo.join(', ')}
                    </p>
                  )}
                </div>
                <Button size="sm" variant="secondary" onClick={() => dismissLesson(lesson.id)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
