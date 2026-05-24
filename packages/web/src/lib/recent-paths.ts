/**
 * Recent Paths Store
 *
 * Tracks recent workspace paths used for session creation.
 * Uses localStorage for persistence across sessions.
 */

interface RecentPath {
  path: string;
  usedAt: number; // Timestamp
}

const STORAGE_KEY = 'neokai_recent_paths';
const MAX_RECENT_PATHS = 10;

/**
 * Get recent paths from localStorage
 */
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

/**
 * Add a path to recent paths
 */
export function addRecentPath(path: string): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const paths: RecentPath[] = stored ? JSON.parse(stored) : [];

    // Remove existing entry for this path (if any)
    const filtered = paths.filter((p) => p.path !== path);

    // Add new entry at the beginning
    filtered.unshift({
      path,
      usedAt: Date.now(),
    });

    // Keep only MAX_RECENT_PATHS
    const trimmed = filtered.slice(0, MAX_RECENT_PATHS);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Silently fail if localStorage is unavailable
  }
}
