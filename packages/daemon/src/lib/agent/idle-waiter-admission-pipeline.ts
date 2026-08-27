import superpipe, { type PipelineAPI } from 'superpipe';

export interface IdleOwnerScope {
  queryGeneration: number;
  turnToken: number;
}

export interface IdleWaiterAdmissionInput {
  waiterOwner?: IdleOwnerScope;
  transitionOwner?: IdleOwnerScope;
  currentOwner: IdleOwnerScope;
}

export interface IdleWaiterAdmissionCtx extends IdleWaiterAdmissionInput {
  admitted: boolean | null;
}

export function isSameIdleOwner(a: IdleOwnerScope, b: IdleOwnerScope): boolean {
  return a.queryGeneration === b.queryGeneration && a.turnToken === b.turnToken;
}

export function admitUnownedWaiter(ctx: IdleWaiterAdmissionCtx): IdleWaiterAdmissionCtx {
  if (ctx.waiterOwner === undefined) return { ...ctx, admitted: true };
  return ctx;
}

export function admitTransitionOwnedWaiter(ctx: IdleWaiterAdmissionCtx): IdleWaiterAdmissionCtx {
  const { waiterOwner, transitionOwner } = ctx;
  if (waiterOwner === undefined || transitionOwner === undefined) return ctx;
  return { ...ctx, admitted: isSameIdleOwner(waiterOwner, transitionOwner) };
}

export function admitCurrentEpochWaiter(ctx: IdleWaiterAdmissionCtx): IdleWaiterAdmissionCtx {
  const { waiterOwner, currentOwner } = ctx;
  if (waiterOwner === undefined) return ctx;
  const admitted =
    waiterOwner.queryGeneration === currentOwner.queryGeneration &&
    waiterOwner.turnToken <= currentOwner.turnToken;
  return { ...ctx, admitted };
}

const runIdleWaiterAdmission = (
  superpipe({
    hasVerdict: (ctx: IdleWaiterAdmissionCtx) => ctx.admitted !== null,
  })('idle-waiter-admission') as PipelineAPI
)
  .input(['ctx'])
  .pipe(admitUnownedWaiter, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .pipe(admitTransitionOwnedWaiter, 'ctx', 'ctx')
  .pipe('!hasVerdict', 'ctx')
  .pipe(admitCurrentEpochWaiter, 'ctx', 'ctx')
  .end('ctx') as (ctx: IdleWaiterAdmissionCtx) => IdleWaiterAdmissionCtx;

export function isIdleWaiterAdmitted(input: IdleWaiterAdmissionInput): boolean {
  const ctx = runIdleWaiterAdmission({ ...input, admitted: null });
  return ctx.admitted === true;
}
