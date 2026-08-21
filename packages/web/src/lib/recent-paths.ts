interface RecentPath {
  path: string;
  usedAt: number;
}

const STORAGE_KEY = 'hyperneo_recent_paths';
const MAX_RECENT_PATHS = 10;

export function getRecentPaths(): Array<{ path: string; usedAt: Date }> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];

    const paths: RecentPath[] = JSON.parse(stored);
    return paths
      .sort((a, b) => b.usedAt - a.usedAt)
      .slice(0, MAX_RECENT_PATHS)
      .map((p) => ({
        path: p.path,
        usedAt: new Date(p.usedAt),
      }));
  } catch {
    return [];
  }
}

export function addRecentPath(path: string): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const paths: RecentPath[] = stored ? JSON.parse(stored) : [];

    const filtered = paths.filter((p) => p.path !== path);

    filtered.unshift({
      path,
      usedAt: Date.now(),
    });

    const trimmed = filtered.slice(0, MAX_RECENT_PATHS);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {}
}
