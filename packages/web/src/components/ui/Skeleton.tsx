import { cn } from '../../lib/utils.ts';

export interface SkeletonProps {
  variant?: 'text' | 'circle' | 'rectangle';
  width?: string | number;
  height?: string | number;
  class?: string;
}

export function Skeleton({ variant = 'text', width, height, class: className }: SkeletonProps) {
  const baseStyles = 'skeleton';

  const variants = {
    text: 'h-4 rounded',
    circle: 'rounded-full',
    rectangle: 'rounded-lg',
  };

  const style: Record<string, string> = {};
  if (width) {
    style.width = typeof width === 'number' ? `${width}px` : width;
  }
  if (height) {
    style.height = typeof height === 'number' ? `${height}px` : height;
  }

  return <div class={cn(baseStyles, variants[variant], className)} style={style} />;
}

function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div class="space-y-3">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

export function SkeletonMessage() {
  return (
    <div class="flex gap-3 p-4">
      <Skeleton variant="circle" width={40} height={40} />
      <div class="flex-1 space-y-3">
        <Skeleton width="30%" height={16} />
        <SkeletonText lines={2} />
      </div>
    </div>
  );
}
