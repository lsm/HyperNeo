interface Frame {
  name?: string;
  sourceURL?: string;
  line?: number;
}

interface Profile {
  traces: { frames: Frame[] }[];
}

interface Stack {
  samples: number;
  frames: { name: string; file: string; line: number | null }[];
}

interface Report {
  status: 'captured' | 'rate_limited' | 'failed' | 'starting' | 'unsupported';
  fromMs?: number;
  untilMs?: number;
  sampleCount?: number;
  droppedSamples?: number;
  stacks?: Stack[];
}

function hottestStacks(profile: Profile): Stack[] {
  const groups = new Map<string, Stack>();
  for (const trace of profile.traces.slice(-2000)) {
    const frames = trace.frames.slice(0, 6).map((frame) => ({
      name: (frame.name ?? '(anonymous)').replace(/\s+/g, ' ').slice(0, 120),
      file: /^(data|blob):/.test(frame.sourceURL ?? '')
        ? '[inline]'
        : (frame.sourceURL ?? '[native]').split(/[?#]/)[0].slice(0, 300),
      line:
        Number.isInteger(frame.line) && frame.line! > 0 && frame.line! < 2 ** 31
          ? frame.line!
          : null,
    }));
    const key = JSON.stringify(frames);
    const group = groups.get(key);
    if (group) group.samples++;
    else groups.set(key, { samples: 1, frames });
  }
  return [...groups.values()].sort((a, b) => b.samples - a.samples).slice(0, 5);
}

export function createLagSamplingProfiler(read: () => Profile, fromMs: number) {
  let previous = fromMs;
  let reports: number[] = [];
  return {
    tick(blocked: boolean, at: number): Report | undefined {
      let profile: Profile;
      try {
        profile = read();
      } catch {
        return blocked ? { status: 'failed' } : undefined;
      }
      const from = previous;
      previous = at;
      if (!blocked) return;
      reports = reports.filter((time) => at - time < 3_600_000);
      if (reports.length === 3) return { status: 'rate_limited' };
      reports.push(at);
      return {
        status: 'captured',
        fromMs: from,
        untilMs: at,
        sampleCount: profile.traces.length,
        ...(profile.traces.length > 2000 ? { droppedSamples: profile.traces.length - 2000 } : {}),
        stacks: hottestStacks(profile),
      };
    },
  };
}

export type LagSamplingTick = (blocked: boolean, at: number) => Report | undefined;
