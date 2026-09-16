export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

export class WorkflowDeletionBlockedError extends WorkflowValidationError {
  constructor(
    message: string,
    readonly workflowId: string
  ) {
    super(message);
    this.name = 'WorkflowDeletionBlockedError';
  }
}
