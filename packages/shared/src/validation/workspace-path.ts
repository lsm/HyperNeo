export interface WorkspacePathValidationResult {
  valid: boolean;
  error?: string;
}

export function validateWorkspacePath(path: string): WorkspacePathValidationResult {
  if (!path || path.trim() === '') {
    return { valid: false, error: 'Workspace path must not be empty' };
  }

  if (!path.startsWith('/')) {
    return { valid: false, error: 'Workspace path must be an absolute path (start with /)' };
  }

  return { valid: true };
}
