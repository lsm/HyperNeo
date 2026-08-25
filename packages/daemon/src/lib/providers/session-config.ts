import type { Session } from '@hyperneo/shared';
import type { ProviderSessionConfig } from '@hyperneo/shared/provider';

export function providerSessionConfigForSession(session: Session): ProviderSessionConfig {
  const effectiveWorkspacePath = session.worktree?.worktreePath ?? session.workspacePath;
  return {
    workspacePath: effectiveWorkspacePath ?? undefined,
    sessionId: session.id,
    ...(session.config.providerConfig
      ? {
          apiKey: session.config.providerConfig.apiKey,
          baseUrl: session.config.providerConfig.baseUrl,
          region: session.config.providerConfig.region,
        }
      : {}),
  };
}
