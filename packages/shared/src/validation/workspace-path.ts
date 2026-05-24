/**
 * Workspace path validation utilities.
 *
 * NOTE: POSIX paths only — Windows paths (e.g. `C:\foo`) are out of scope.
 */

export interface WorkspacePathValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates that a workspace path is a non-empty absolute POSIX path.
 *
 * This is a format-only check (no filesystem access). Server-side code is
 * responsible for verifying that the path exists and is accessible.
 */
export function validateWorkspacePath(path: string): WorkspacePathValidationResult {
  if (!path || path.trim() === '') {
    return { valid: false, error: 'Workspace path must not be empty' };
  }

  if (!path.startsWith('/')) {
    return { valid: false, error: 'Workspace path must be an absolute path (start with /)' };
  }

  return { valid: true };
}
