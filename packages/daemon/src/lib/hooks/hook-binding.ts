import type { WorkflowHookResult } from '@hyperneo/shared';
import { Logger } from '../logger.ts';
import type { HookActionMeta, HookEngine } from './hook-engine.ts';

const log = new Logger('hook-binding');

const FOLLOW_UP_METHODS = new Set(['send_message']);

const DEFAULT_FOLLOW_UP_TIMEOUT_MS = 30_000;

export const DEFAULT_RETRYABLE_ACTION_DELAY_MS = 30_000;

interface PendingRetryableHookAction {
  actionKey: string;
  delayMs: number;
  methodName: string;
  args: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<AnyToolResult>;
  engine: HookEngine;
  handlers: Record<string, (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult>;
  meta: HookActionMeta;
  isFollowUp: boolean;
  handlerIncludesHooks: boolean;
}

const pendingRetryableHookActions = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; options: PendingRetryableHookAction }
>();
const RAW_HANDLER = Symbol('rawHandler');

function hookResult(
  data: Record<string, unknown>,
  isError = false
): import('../space/tools/tool-result.ts').ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError };
}

export type AnyToolResult = import('../space/tools/tool-result.ts').ToolResult;

type WrappedHandler<T extends Record<string, unknown>> = ((args: T) => Promise<AnyToolResult>) & {
  [RAW_HANDLER]?: (args: T) => Promise<AnyToolResult>;
};

function buildRetryableActionKey(
  methodName: string,
  args: Record<string, unknown>,
  meta: HookActionMeta
): string {
  return JSON.stringify({
    runScopedTaskId: meta.taskId,
    nodeId: meta.nodeId,
    sessionId: meta.sessionId,
    agentName: meta.agentName,
    methodName,
    args,
  });
}

export function scheduleRetryableAction<T extends Record<string, unknown>>(options: {
  actionKey: string;
  delayMs: number;
  methodName: string;
  args: T;
  handler: (args: T) => Promise<AnyToolResult>;
  engine: HookEngine;
  handlers: Record<string, (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult>;
  meta: HookActionMeta;
  isFollowUp: boolean;
  handlerIncludesHooks?: boolean;
}): void {
  if (pendingRetryableHookActions.has(options.actionKey)) return;

  const timer = setTimeout(() => {
    pendingRetryableHookActions.delete(options.actionKey);
    void replayRetryableAction(options).catch((err) => {
      log.warn(
        `Retryable hook action retry failed for ${options.methodName}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }, options.delayMs);

  pendingRetryableHookActions.set(options.actionKey, {
    timer,
    options: {
      ...options,
      args: options.args,
      handler: async (args) => options.handler(args as T),
      handlerIncludesHooks: options.handlerIncludesHooks ?? false,
    },
  });
}

export function clearRetryableHookActionTimer(actionKey: string): void {
  const pending = pendingRetryableHookActions.get(actionKey);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRetryableHookActions.delete(actionKey);
}

export function triggerRetryableHookAction(actionKey: string): boolean {
  const pending = pendingRetryableHookActions.get(actionKey);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRetryableHookActions.delete(actionKey);
  void replayRetryableAction(pending.options).catch((err) => {
    log.warn(
      `Manual retryable hook action retry failed for ${pending.options.methodName}: ${err instanceof Error ? err.message : String(err)}`
    );
  });
  return true;
}

export function clearAllRetryableHookActionTimers(): void {
  for (const pending of pendingRetryableHookActions.values()) {
    clearTimeout(pending.timer);
  }
  pendingRetryableHookActions.clear();
}

async function replayRetryableAction<T extends Record<string, unknown>>(options: {
  actionKey: string;
  methodName: string;
  args: T;
  handler: (args: T) => Promise<AnyToolResult>;
  engine: HookEngine;
  handlers: Record<string, (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult>;
  meta: HookActionMeta;
  isFollowUp: boolean;
  handlerIncludesHooks?: boolean;
}): Promise<void> {
  if (options.engine.isRetryableActionCancelled(options.meta)) {
    options.engine.clearQueuedRetryableActionsForKey(options.actionKey);
    clearRetryableHookActionTimer(options.actionKey);
    return;
  }

  const retryHandler = options.handlerIncludesHooks
    ? options.handler
    : wrapHandlerWithHooks(
        options.methodName,
        options.handler,
        options.engine,
        options.handlers,
        options.meta,
        options.isFollowUp
      );
  const result = await retryHandler(options.args);
  const failure = getToolResultFailure(result);
  if (failure && !failure.retryable) {
    try {
      await options.engine.notifySourceSession(
        options.meta.sessionId,
        `Queued ${options.methodName} retry failed: ${failure.message}`
      );
    } catch (err) {
      log.warn(
        `Failed to notify source session for queued ${options.methodName} retry failure: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      options.engine.clearQueuedRetryableActionsForKey(options.actionKey);
      clearRetryableHookActionTimer(options.actionKey);
    }
  }
}

function getToolResultFailure(
  result: AnyToolResult
): { message: string; retryable: boolean } | undefined {
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (!text) {
    return result.isError ? { message: 'tool returned an error', retryable: false } : undefined;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return result.isError ? { message: text, retryable: false } : undefined;
  }

  if (!data || typeof data !== 'object') {
    return result.isError ? { message: text, retryable: false } : undefined;
  }

  const record = data as Record<string, unknown>;
  const success = record.success;
  const retryable = record.retryable === true;
  if (success === false || result.isError) {
    const message =
      typeof record.error === 'string'
        ? record.error
        : typeof record.message === 'string'
          ? record.message
          : text;
    return { message, retryable };
  }
  return undefined;
}

export function wrapHandlerWithHooks<T extends Record<string, unknown>>(
  methodName: string,
  handler: (args: T) => Promise<AnyToolResult>,
  engine: HookEngine | undefined,
  handlers: Record<string, (...args: unknown[]) => Promise<AnyToolResult> | AnyToolResult>,
  meta: HookActionMeta,
  isFollowUp = false
) {
  if (!engine) return handler;

  const wrapped = async (args: T) => {
    const actionKey = buildRetryableActionKey(methodName, args as Record<string, unknown>, meta);
    const outcome = await engine.executeAction(methodName, args as Record<string, unknown>, meta);

    const updatesByHook = new Map<
      string,
      { state: Record<string, unknown>; result?: WorkflowHookResult }
    >();
    for (const update of outcome.stateUpdates) {
      updatesByHook.set(update.hookId, { state: update.state });
    }
    for (const record of outcome.executionLog) {
      const existing = updatesByHook.get(record.hookId);
      if (existing) {
        existing.result = record.result;
      } else {
        updatesByHook.set(record.hookId, { state: {}, result: record.result });
      }
    }
    for (const [hookId, { state, result }] of updatesByHook) {
      const ok = engine.persistStateUpdate(hookId, state, result);
      if (!ok) {
        log.warn(
          `Failed to persist hook state/result for ${hookId}: version conflict or repo error`
        );
      }
    }

    if (outcome.decision === 'block') {
      if (outcome.blockedByHookId) {
        for (const queuedActionKey of engine.clearQueuedRetryableActionsForOwner(
          [outcome.blockedByHookId],
          meta
        )) {
          clearRetryableHookActionTimer(queuedActionKey);
        }
      }
      engine.clearQueuedRetryableActionsForKey(actionKey);
      clearRetryableHookActionTimer(actionKey);
      return hookResult(
        {
          success: false,
          error: outcome.userState.reason ?? 'Action blocked by hook.',
          hookStatus: outcome.userState.status,
          hookLabel: outcome.userState.hookLabel,
          hookMethod: outcome.userState.method,
          hookReason: outcome.userState.reason,
          hookRemediation: outcome.userState.remediation,
          sourceNode: outcome.userState.sourceNode,
        },
        true
      );
    }

    if (outcome.decision === 'retryable_block') {
      const retryAfterMs = outcome.userState.retryAfterMs ?? DEFAULT_RETRYABLE_ACTION_DELAY_MS;
      if (methodName === 'send_message') {
        if (outcome.blockedByHookId) {
          const existingQueued = engine.clearQueuedRetryableActionForHook(outcome.blockedByHookId);
          if (existingQueued) clearRetryableHookActionTimer(existingQueued.actionKey);
          const now = Date.now();
          const persisted = engine.persistQueuedRetryableAction({
            actionKey,
            hookId: outcome.blockedByHookId,
            methodName,
            args: args as Record<string, unknown>,
            meta,
            isFollowUp,
            nextRetryAt: now + retryAfterMs,
            retryAfterMs,
            queuedAt: now,
          });
          if (!persisted) {
            log.warn(
              `Failed to persist queued retryable hook action for ${methodName}: ${outcome.blockedByHookId}`
            );
          }
        }
        if (engine.isRetryableActionCancelled(meta)) {
          engine.clearQueuedRetryableActionsForKey(actionKey);
          clearRetryableHookActionTimer(actionKey);
          return hookResult({
            success: true,
            queued: false,
            cancelled: true,
            retryable: false,
            hookStatus: outcome.userState.status,
            hookLabel: outcome.userState.hookLabel,
            hookMethod: outcome.userState.method,
            hookReason: outcome.userState.reason,
            hookRemediation: outcome.userState.remediation,
            sourceNode: outcome.userState.sourceNode,
            message: 'Queued action cancelled because task or workflow run is no longer active.',
          });
        }
        scheduleRetryableAction({
          actionKey,
          delayMs: retryAfterMs,
          methodName,
          args,
          handler,
          engine,
          handlers,
          meta,
          isFollowUp,
        });
        return hookResult({
          success: true,
          queued: true,
          retryable: true,
          retryAfterMs,
          hookStatus: outcome.userState.status,
          hookLabel: outcome.userState.hookLabel,
          hookMethod: outcome.userState.method,
          hookReason: outcome.userState.reason,
          hookRemediation: outcome.userState.remediation,
          sourceNode: outcome.userState.sourceNode,
          message:
            outcome.userState.reason ??
            `Action queued until hook "${outcome.userState.hookLabel ?? outcome.blockedByHookId ?? 'unknown'}" allows it.`,
        });
      }
      return hookResult(
        {
          success: false,
          error: outcome.userState.reason ?? 'Action blocked by hook (retryable).',
          retryable: true,
          retryAfterMs,
          hookStatus: outcome.userState.status,
          hookLabel: outcome.userState.hookLabel,
          hookMethod: outcome.userState.method,
          hookReason: outcome.userState.reason,
          hookRemediation: outcome.userState.remediation,
          sourceNode: outcome.userState.sourceNode,
        },
        true
      );
    }

    const successfulHookIds = outcome.executionLog.map((record) => record.hookId);
    for (const queuedActionKey of engine.clearQueuedRetryableActionsForOwner(
      successfulHookIds,
      meta
    )) {
      clearRetryableHookActionTimer(queuedActionKey);
    }
    engine.clearQueuedRetryableActionsForKey(actionKey);
    clearRetryableHookActionTimer(actionKey);

    const nestedFollowUpSuppressed = outcome.followUpRequests.length > 0 && isFollowUp;
    if (nestedFollowUpSuppressed) {
      log.warn('Nested follow-up emission suppressed during follow-up dispatch.');
    }

    if (outcome.followUpRequests.length > 0 && !nestedFollowUpSuppressed) {
      const followUpMethod = 'send_message';
      if (!FOLLOW_UP_METHODS.has(followUpMethod)) {
        return hookResult(
          {
            success: false,
            error: `Follow-up method "${followUpMethod}" is not whitelisted.`,
          },
          true
        );
      }

      const followUpHandler = handlers[followUpMethod];
      if (!followUpHandler) {
        return hookResult(
          {
            success: false,
            error: `Follow-up handler "${followUpMethod}" not found.`,
          },
          true
        );
      }

      const rawFollowUpHandler =
        ((followUpHandler as unknown as WrappedHandler<Record<string, unknown>>)[RAW_HANDLER] as
          | ((args: Record<string, unknown>) => Promise<AnyToolResult>)
          | undefined) ?? followUpHandler;

      const followUpPromises = outcome.followUpRequests.map((req) => {
        const dispatchPromise = wrapHandlerWithHooks(
          followUpMethod,
          rawFollowUpHandler as (args: Record<string, unknown>) => Promise<AnyToolResult>,
          engine,
          handlers,
          { ...meta, targetNode: req.targetNode },
          true
        )({
          target: req.targetNode,
          message: req.message,
        } as unknown as Record<string, unknown>);

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('Follow-up dispatch timed out')),
            DEFAULT_FOLLOW_UP_TIMEOUT_MS
          );
        });

        return Promise.race([dispatchPromise, timeoutPromise]);
      });

      try {
        await Promise.all(followUpPromises);
      } catch (err) {
        log.warn(
          `Follow-up dispatch timed out or failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return handler(outcome.finalParams as T);
  };

  (wrapped as unknown as WrappedHandler<T>)[RAW_HANDLER] = handler;
  return wrapped;
}
