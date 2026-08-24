export interface StartupPhaseTimer {
  start(name: string): void;
  finish(): void;
}

export function createStartupPhaseTimer(
  log: ((message: string) => void) | null,
  now: () => number = Date.now
): StartupPhaseTimer {
  let currentName: string | null = null;
  let phaseStartedAt = 0;
  let startupStartedAt: number | null = null;
  let step = 0;

  const complete = (completedAt: number): void => {
    if (currentName === null || startupStartedAt === null || log === null) return;
    log(
      `[startup ${++step}] ${currentName} (+${completedAt - phaseStartedAt}ms, total ${completedAt - startupStartedAt}ms)`
    );
    currentName = null;
  };

  return {
    start(name) {
      if (log === null) return;
      const startedAt = now();
      complete(startedAt);
      startupStartedAt ??= startedAt;
      currentName = name;
      phaseStartedAt = startedAt;
    },
    finish() {
      if (log === null || currentName === null) return;
      complete(now());
    },
  };
}
