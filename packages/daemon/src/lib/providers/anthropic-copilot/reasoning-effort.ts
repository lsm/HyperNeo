import type { CopilotClient, SessionConfig } from '@github/copilot-sdk';

export type ReasoningEffort = NonNullable<SessionConfig['reasoningEffort']>;

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const SUPPORT_TTL_MS = 10 * 60_000;
const LEVEL_EFFORTS: Record<string, ReasoningEffort> = {
  off: 'low',
  think8k: 'low',
  think16k: 'medium',
  think24k: 'high',
  think32k: 'xhigh',
};

export function reasoningEffortForLevel(level: string | undefined): ReasoningEffort | undefined {
  return level ? LEVEL_EFFORTS[level] : undefined;
}

export function fitReasoningEffort(
  wanted: ReasoningEffort | undefined,
  supported: readonly ReasoningEffort[] | undefined
): ReasoningEffort | undefined {
  if (!wanted || !supported?.length) return undefined;
  const ranked = [...supported].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const below = ranked.filter((effort) => EFFORTS.indexOf(effort) <= EFFORTS.indexOf(wanted));
  return below.at(-1) ?? ranked[0];
}

export function createReasoningSupport(client: CopilotClient, now: () => number = Date.now) {
  let cached: { at: number; efforts: Promise<Map<string, ReasoningEffort[]>> } | undefined;
  return async (model: string): Promise<readonly ReasoningEffort[] | undefined> => {
    if (!cached || now() - cached.at > SUPPORT_TTL_MS) {
      const efforts = client
        .listModels()
        .then(
          (models) =>
            new Map(
              models.map((model) => [
                model.id,
                model.capabilities?.supports?.reasoningEffort
                  ? (model.supportedReasoningEfforts ?? [])
                  : [],
              ])
            )
        );
      cached = { at: now(), efforts };
      efforts.catch(() => {
        if (cached?.efforts === efforts) cached = undefined;
      });
    }
    return (await cached.efforts.catch(() => new Map<string, ReasoningEffort[]>())).get(model);
  };
}
