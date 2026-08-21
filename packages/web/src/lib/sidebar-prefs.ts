const COLLAPSED_PROJECTS_KEY = 'hyperneo_sidebar_collapsed_projects';

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

export function setCollapsedProjects(paths: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...paths]));
  } catch {}
}
