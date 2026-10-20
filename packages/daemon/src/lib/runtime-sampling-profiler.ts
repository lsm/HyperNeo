import type { createLagSamplingProfiler } from './event-loop-sampling.ts';

type ReadProfile = Parameters<typeof createLagSamplingProfiler>[0];

export async function loadRuntimeSamplingProfiler(
  isActive: () => boolean
): Promise<ReadProfile | null> {
  if (!process.versions.bun) return null;
  const jsc = (await import('bun:jsc')) as unknown as {
    startSamplingProfiler(directory?: string, sampleInterval?: number): void;
    samplingProfilerStackTraces: ReadProfile;
  };
  if (
    typeof jsc.startSamplingProfiler !== 'function' ||
    typeof jsc.samplingProfilerStackTraces !== 'function' ||
    !isActive()
  )
    return null;
  jsc.startSamplingProfiler(undefined, 10_000);
  jsc.samplingProfilerStackTraces();
  return () => jsc.samplingProfilerStackTraces();
}
