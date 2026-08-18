import { Skeleton } from '../../src/mod.ts';

export function SkeletonDemo() {
  return (
    <div class="space-y-8">
      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Text skeleton (single line)</h3>
        <Skeleton class="h-4 w-48 rounded bg-surface-3 animate-pulse" />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Multiple lines (paragraph placeholder)
        </h3>
        <div class="space-y-2 max-w-sm">
          <Skeleton class="h-4 w-full rounded bg-surface-3 animate-pulse" />
          <Skeleton class="h-4 w-5/6 rounded bg-surface-3 animate-pulse" />
          <Skeleton class="h-4 w-4/6 rounded bg-surface-3 animate-pulse" />
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          Circle skeleton (avatar placeholder)
        </h3>
        <Skeleton class="w-12 h-12 rounded-full bg-surface-3 animate-pulse" />
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">Card skeleton (composed layout)</h3>
        <div class="max-w-sm bg-surface-2 border border-surface-border rounded-xl p-4 space-y-4">
          <div class="flex items-center gap-3">
            <Skeleton class="w-10 h-10 rounded-full bg-surface-3 animate-pulse shrink-0" />
            <div class="flex-1 space-y-2">
              <Skeleton class="h-3.5 w-32 rounded bg-surface-3 animate-pulse" />
              <Skeleton class="h-3 w-20 rounded bg-surface-3 animate-pulse" />
            </div>
          </div>
          <Skeleton class="w-full h-32 rounded-lg bg-surface-3 animate-pulse" />
          <div class="space-y-2">
            <Skeleton class="h-3.5 w-full rounded bg-surface-3 animate-pulse" />
            <Skeleton class="h-3.5 w-11/12 rounded bg-surface-3 animate-pulse" />
            <Skeleton class="h-3.5 w-8/12 rounded bg-surface-3 animate-pulse" />
          </div>
          <div class="flex gap-2">
            <Skeleton class="h-8 w-20 rounded-lg bg-surface-3 animate-pulse" />
            <Skeleton class="h-8 w-20 rounded-lg bg-surface-3 animate-pulse" />
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">
          animation prop — pulse (default) vs none
        </h3>
        <div class="flex gap-6">
          <div class="space-y-1">
            <p class="text-xs text-text-muted mb-2">animation="pulse"</p>
            <Skeleton animation="pulse" class="h-4 w-40 rounded bg-surface-3 animate-pulse" />
          </div>
          <div class="space-y-1">
            <p class="text-xs text-text-muted mb-2">animation="none"</p>
            <Skeleton animation="none" class="h-4 w-40 rounded bg-surface-3" />
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-medium text-text-tertiary mb-3">List skeleton</h3>
        <div class="max-w-sm space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} class="flex items-center gap-3">
              <Skeleton class="w-8 h-8 rounded-full bg-surface-3 animate-pulse shrink-0" />
              <div class="flex-1 space-y-1.5">
                <Skeleton class="h-3.5 w-28 rounded bg-surface-3 animate-pulse" />
                <Skeleton class="h-3 w-44 rounded bg-surface-3 animate-pulse" />
              </div>
              <Skeleton class="h-6 w-14 rounded-full bg-surface-3 animate-pulse shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
