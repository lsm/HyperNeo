import type { WorkflowHook } from '@hyperneo/shared';
import {
  isWorkflowHookCallerAuthorized,
  validateWorkflowHookResult,
  type WorkflowHookInvocationContext,
} from './hook-validation.ts';

export class WorkflowHookRuntimeService {
  isCallerAuthorized(hook: WorkflowHook, context: WorkflowHookInvocationContext): boolean {
    return isWorkflowHookCallerAuthorized(hook, context);
  }

  validateResult(result: unknown): string[] {
    return validateWorkflowHookResult(result);
  }
}
