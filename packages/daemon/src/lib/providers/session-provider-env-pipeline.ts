import superpipe, { type PipelineAPI } from 'superpipe';
import type { Provider as SdkProvider, ProviderSessionConfig } from '@hyperneo/shared/provider';
import type { ProviderEnvVars } from '../provider-service.ts';

export interface SessionProviderEnvRequest {
  providerId: string;
  modelId: string;
  sessionConfig: ProviderSessionConfig;
  sessionId: string;
  provider: SdkProvider | null;
  envVars: ProviderEnvVars | null;
}

export type SessionProviderEnvStages = {
  resolveProvider(request: SessionProviderEnvRequest): SessionProviderEnvRequest;
  warmBridge(request: SessionProviderEnvRequest): Promise<SessionProviderEnvRequest>;
  buildEnvOnce(request: SessionProviderEnvRequest): SessionProviderEnvRequest;
  recoverBridge(request: SessionProviderEnvRequest): Promise<SessionProviderEnvRequest>;
  rebuildEnvOrReject(request: SessionProviderEnvRequest): SessionProviderEnvRequest;
  envAlreadyBuilt(request: SessionProviderEnvRequest): boolean;
};

export function makeSessionProviderEnvStages(deps: {
  getProvider(providerId: string): SdkProvider | undefined;
  ensureBridgeBestEffort(
    provider: SdkProvider,
    modelId: string,
    sessionConfig: ProviderSessionConfig
  ): Promise<void>;
  retryBridgeStart(
    provider: SdkProvider,
    modelId: string,
    sessionConfig: ProviderSessionConfig
  ): Promise<void>;
  buildEnvVars(
    provider: SdkProvider,
    modelId: string,
    sessionConfig: ProviderSessionConfig
  ): ProviderEnvVars;
}): SessionProviderEnvStages {
  return {
    resolveProvider(request) {
      const provider = deps.getProvider(request.providerId);
      if (!provider) {
        throw new Error(
          `Provider '${request.providerId}' is not registered; cannot prepare environment for ` +
            `session '${request.sessionId}' (model '${request.modelId}')`
        );
      }
      return { ...request, provider };
    },
    async warmBridge(request) {
      await deps.ensureBridgeBestEffort(request.provider!, request.modelId, request.sessionConfig);
      return request;
    },
    buildEnvOnce(request) {
      try {
        return {
          ...request,
          envVars: deps.buildEnvVars(request.provider!, request.modelId, request.sessionConfig),
        };
      } catch {
        return request;
      }
    },
    async recoverBridge(request) {
      const liveProvider = deps.getProvider(request.providerId) ?? request.provider!;
      try {
        await deps.retryBridgeStart(liveProvider, request.modelId, request.sessionConfig);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Provider '${request.providerId}' failed to start its bridge for model ` +
            `'${request.modelId}' (session '${request.sessionId}'): ${detail}`
        );
      }
      return { ...request, provider: liveProvider };
    },
    rebuildEnvOrReject(request) {
      try {
        return {
          ...request,
          envVars: deps.buildEnvVars(request.provider!, request.modelId, request.sessionConfig),
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Provider '${request.providerId}' environment could not be built for model ` +
            `'${request.modelId}' (session '${request.sessionId}'): ${detail}`
        );
      }
    },
    envAlreadyBuilt(request) {
      return request.envVars !== null;
    },
  };
}

export function runSessionProviderEnvPipeline(
  stages: SessionProviderEnvStages,
  input: Omit<SessionProviderEnvRequest, 'envVars'>
): Promise<ProviderEnvVars> {
  const run = (
    superpipe<SessionProviderEnvStages>(stages)('resolve-session-provider-env') as PipelineAPI
  )
    .input(['request'])
    .pipe('resolveProvider', 'request', 'request')
    .pipe('warmBridge', 'request', 'request')
    .pipe('buildEnvOnce', 'request', 'request')
    .pipe('!envAlreadyBuilt', 'request')
    .pipe('recoverBridge', 'request', 'request')
    .pipe('rebuildEnvOrReject', 'request', 'request')
    .endAsync('request') as (
    request: SessionProviderEnvRequest
  ) => Promise<SessionProviderEnvRequest | Error>;
  return run({ ...input, envVars: null }).then((outcome) => {
    if (outcome instanceof Error) throw outcome;
    if (!outcome.envVars) {
      throw new Error(
        `Provider '${input.providerId}' environment resolution ended without env vars ` +
          `(session '${input.sessionId}')`
      );
    }
    return outcome.envVars;
  });
}
