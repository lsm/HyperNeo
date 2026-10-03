export type NeoWorkSurfaceSwipePoint = { readonly x: number; readonly y: number };

export function neoWorkSurfaceSwipe(
  start: NeoWorkSurfaceSwipePoint,
  end: NeoWorkSurfaceSwipePoint,
  options: { readonly open: boolean; readonly width: number }
): 'open' | 'close' | null {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (Math.abs(deltaY) >= Math.abs(deltaX)) return null;
  if (options.open) return deltaX >= 60 ? 'close' : null;
  const fromRightEdge = start.x >= options.width - 32;
  return deltaX <= (fromRightEdge ? -30 : -60) ? 'open' : null;
}
