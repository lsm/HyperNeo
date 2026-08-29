import { decisionRun } from '../../space/runtime/decision-pipeline.ts';

export type SelfEchoVerdict = 'admit' | 'drop';

export function decideSelfEchoFilter({
  initiatorLogin,
  filteredLogins,
  enabled,
}: {
  initiatorLogin: string;
  filteredLogins: string[];
  enabled: boolean;
}): SelfEchoVerdict {
  if (!enabled) return 'admit';
  if (!initiatorLogin) return 'admit';
  const normalized = initiatorLogin.toLowerCase();
  for (const login of filteredLogins) {
    if (login.toLowerCase() === normalized) return 'drop';
  }
  return 'admit';
}

export function resolveFilteredLogins({
  filterCurrentUser,
  tokenLogin,
}: {
  filterCurrentUser: boolean;
  tokenLogin: string;
}): string[] {
  return filterCurrentUser && tokenLogin ? [tokenLogin] : [];
}

export interface SelfEchoGateCtx {
  initiatorLogin: string;
  filteredLogins: string[];
  filterCurrentUser: boolean;
  decision: SelfEchoVerdict | null;
}

export type SelfEchoGateInput = Omit<SelfEchoGateCtx, 'decision'>;

function applySelfEchoGate(ctx: SelfEchoGateCtx): SelfEchoGateCtx {
  return ctx.decision === null
    ? {
        ...ctx,
        decision: decideSelfEchoFilter({
          initiatorLogin: ctx.initiatorLogin,
          filteredLogins: ctx.filteredLogins,
          enabled: ctx.filterCurrentUser,
        }),
      }
    : ctx;
}

const selfEchoGateRun = decisionRun<SelfEchoGateCtx>('github-self-echo-gate', [applySelfEchoGate]);

export function decideSelfEchoGate(input: SelfEchoGateInput): SelfEchoVerdict {
  return selfEchoGateRun(input).decision ?? 'admit';
}
