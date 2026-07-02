import type { WorkflowHook } from '@hyperneo/shared';
import {
  isWorkflowHookCallerAuthorized,
  type WorkflowHookInvocationContext,
  validateWorkflowHookResult,
} from './workflow-hook-validation';

export class WorkflowHookRuntimeService {
  isCallerAuthorized(hook: WorkflowHook, context: WorkflowHookInvocationContext): boolean {
    return isWorkflowHookCallerAuthorized(hook, context);
  }

  validateResult(result: unknown): string[] {
    return validateWorkflowHookResult(result);
  }
}
