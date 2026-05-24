/**
 * Sidebar Preferences
 *
 * Persists chats-sidebar view state (collapsed project folders) to localStorage
 * so the layout survives reloads.
 */

const COLLAPSED_PROJECTS_KEY = 'neokai_sidebar_collapsed_projects';

/** Read the set of collapsed project paths. */
export function getCollapsedProjects(): Set<string> {
  try {
    const stored = localStorage.getItem(COLLAPSED_PROJECTS_KEY);
    if (!stored) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === 'string'));
  } catch {
    return new Set();
  }
}

/** Persist the set of collapsed project paths. */
export function setCollapsedProjects(paths: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...paths]));
  } catch {
    // Silently fail if localStorage is unavailable.
  }
}
