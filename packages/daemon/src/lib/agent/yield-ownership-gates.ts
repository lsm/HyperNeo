export interface YieldGenerationStamp {
  generation: number;
  stopEpoch: number;
}

export interface YieldedRowSnapshot {
  id: string;
  yieldQueryGeneration?: number;
}

export function isUnfencedGeneration(
  generation: number | null | undefined
): generation is null | undefined {
  return generation === null || generation === undefined;
}

export function evictedYieldKey(generation: number, stopEpoch: number): string {
  return `${generation}:${stopEpoch}`;
}

export function yieldStampOwnsGeneration(stamp: YieldGenerationStamp, generation: number): boolean {
  return stamp.generation === generation;
}

export function yieldStampSurvivesStopEpoch(
  stamp: YieldGenerationStamp,
  stopEpoch: number
): boolean {
  return stamp.stopEpoch === stopEpoch;
}

export function ownsYieldedGeneration(args: {
  yielded: Iterable<YieldedRowSnapshot>;
  lastYieldGenerations: ReadonlyMap<string, YieldGenerationStamp>;
  messageId: string;
  generation: number | null | undefined;
}): boolean {
  if (isUnfencedGeneration(args.generation)) return true;
  for (const row of args.yielded) {
    if (row.id !== args.messageId) continue;
    if (row.yieldQueryGeneration === undefined) return true;
    return row.yieldQueryGeneration === args.generation;
  }
  const stamp = args.lastYieldGenerations.get(args.messageId);
  if (stamp === undefined) return true;
  return yieldStampOwnsGeneration(stamp, args.generation);
}

export function ownsLastYield(args: {
  lastYieldGenerations: ReadonlyMap<string, YieldGenerationStamp>;
  evictedYieldEpochs: ReadonlySet<string>;
  messageId: string;
  generation: number | null | undefined;
  stopEpoch: number;
}): boolean {
  if (isUnfencedGeneration(args.generation)) return true;
  const stamp = args.lastYieldGenerations.get(args.messageId);
  if (stamp === undefined) {
    for (const evictedKey of args.evictedYieldEpochs) {
      const [evictedGeneration, evictedStopEpoch] = evictedKey.split(':');
      if (Number(evictedGeneration) === args.generation) {
        return Number(evictedStopEpoch) === args.stopEpoch;
      }
    }
    return true;
  }
  return (
    yieldStampOwnsGeneration(stamp, args.generation) &&
    yieldStampSurvivesStopEpoch(stamp, args.stopEpoch)
  );
}
