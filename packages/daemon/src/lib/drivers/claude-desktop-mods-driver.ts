import { reuseLiveSessions } from './claude-desktop-adapter.ts';
import { createClaudeDesktopModsControl } from './claude-desktop-mods-control.ts';
import { createClaudeDesktopModsRuntime } from './claude-desktop-mods-runtime.ts';

type Deps = Omit<Parameters<typeof createClaudeDesktopModsRuntime>[0], 'onExchange'> & {
  hasSession(sessionId: string): boolean;
};

export function createClaudeDesktopModsDriver(deps: Deps) {
  if (deps.env.HYPERNEO_CLAUDE_DESKTOP_MODS !== '1') return undefined;
  let runtime: Awaited<ReturnType<typeof createClaudeDesktopModsRuntime>>;
  const ready: Promise<ReturnType<typeof createClaudeDesktopModsControl> | undefined> =
    createClaudeDesktopModsRuntime({
      ...deps,
      liveSessions: reuseLiveSessions(deps.liveSessions, Date.now, 1000),
      onExchange: async (sessionId) => (await ready)?.report(sessionId),
    })
      .then((instance) => {
        runtime = instance;
        return instance
          ? createClaudeDesktopModsControl({ ...deps, runtime: instance })
          : undefined;
      })
      .catch((error: unknown) => {
        deps.onError(error);
        return undefined;
      });
  return {
    ready,
    async close() {
      await ready;
      await runtime?.close();
    },
  };
}
