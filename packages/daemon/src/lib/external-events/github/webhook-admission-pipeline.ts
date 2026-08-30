import superpipe, { type PipelineAPI } from 'superpipe';
import { verifySignature } from '../../github/webhook-handler.ts';
import type { ExternalEventExtensionConfig, SpaceExternalEventSourceConfig } from '../types.ts';
import { statusCommitSha } from './github-event-extension.ts';
import {
  normalizeGitHubDeployment,
  normalizeGitHubDeploymentStatus,
  normalizeGitHubStatus,
  normalizeGitHubWebhook,
  repoFromPayload,
  type GitHubPollingRepo,
  type NormalizedGitHubEvent,
} from './github-normalizer.ts';
import type { GitHubWatchedRepo } from './github-repository.ts';
import {
  admittedWatchedRepos,
  classifyPrResolutionOutcome,
  routeWebhookKind,
  webhookDenialResponse,
  type WebhookDenial,
  type WebhookKind,
  type WebhookResponse,
} from './webhook-routing.ts';

export interface WebhookAdmissionInput {
  signature: string | null;
  eventType: string | null;
  deliveryId: string | null;
  readRaw(): Promise<string>;
}

export interface WebhookAdmissionContext {
  getGlobalConfig(): Promise<ExternalEventExtensionConfig>;
  getSpaceConfig(spaceId: string): Promise<SpaceExternalEventSourceConfig | null>;
  publishEvent(spaceId: string, event: NormalizedGitHubEvent): Promise<void>;
}

export interface WebhookPrResolution {
  prNumbers: number[];
  rateLimited: boolean;
  resolutionFailed: boolean;
}

export interface WebhookAdmissionDeps {
  getContext(): Promise<WebhookAdmissionContext | null>;
  listWebhookValidationRepos(): GitHubWatchedRepo[];
  verifySignature?(raw: string, signature: string, secret: string): Promise<boolean>;
  resolvePrNumbers(repo: GitHubPollingRepo, sha: string): Promise<WebhookPrResolution>;
  markWebhookReceived(repoId: string): void;
}

export interface WebhookAdmissionCtx {
  input: WebhookAdmissionInput;
  deps: Required<WebhookAdmissionDeps>;
  context: WebhookAdmissionContext | null;
  globalConfig: ExternalEventExtensionConfig | null;
  signature: string;
  eventType: string;
  deliveryId: string;
  raw: string;
  matchedRepos: GitHubWatchedRepo[];
  payload: unknown;
  kind: WebhookKind | null;
  normalized: NormalizedGitHubEvent | null;
  admissionRepo: GitHubPollingRepo | null;
  sha: string;
  deploymentRoot: Record<string, unknown>;
  deploymentStatusRoot: Record<string, unknown> | null;
  validForRepo: GitHubWatchedRepo[];
  targets: GitHubWatchedRepo[];
  prNumbers: number[];
  response: WebhookResponse | null;
}

function deny(ctx: WebhookAdmissionCtx, denial: WebhookDenial): WebhookAdmissionCtx {
  return { ...ctx, response: webhookDenialResponse(denial) };
}

function ignored(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  return deny(ctx, { reason: 'ignored', deliveryId: ctx.deliveryId });
}

function received(ctx: WebhookAdmissionCtx, spaces: number): WebhookAdmissionCtx {
  return {
    ...ctx,
    response: {
      status: 200,
      body: { message: 'Webhook received', deliveryId: ctx.deliveryId, spaces },
    },
  };
}

function halted(ctx: WebhookAdmissionCtx): boolean {
  return ctx.response !== null;
}

function objectRoot(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export async function resolveContextStage(ctx: WebhookAdmissionCtx): Promise<WebhookAdmissionCtx> {
  const context = await ctx.deps.getContext();
  if (!context) return deny(ctx, { reason: 'not_started' });
  const globalConfig = await context.getGlobalConfig();
  return { ...ctx, context, globalConfig };
}

export function admitHeadersStage(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  const { signature, eventType, deliveryId } = ctx.input;
  if (!signature) return deny(ctx, { reason: 'missing_signature' });
  if (!eventType || !deliveryId) return deny(ctx, { reason: 'missing_event_headers' });
  return { ...ctx, signature, eventType, deliveryId };
}

export async function matchSignaturesStage(ctx: WebhookAdmissionCtx): Promise<WebhookAdmissionCtx> {
  const raw = await ctx.input.readRaw();
  const matchedRepos: GitHubWatchedRepo[] = [];
  for (const repo of ctx.deps.listWebhookValidationRepos()) {
    if (
      repo.webhookSecret &&
      (await ctx.deps.verifySignature(raw, ctx.signature, repo.webhookSecret))
    ) {
      matchedRepos.push(repo);
    }
  }
  if (matchedRepos.length === 0) return deny(ctx, { reason: 'invalid_signature' });
  return { ...ctx, raw, matchedRepos };
}

export function gateCapabilityStage(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  const global = ctx.globalConfig;
  const enabled =
    global !== null && global.globallyEnabled && global.capabilities.webhooks !== false;
  if (!enabled) return deny(ctx, { reason: 'extension_disabled' });
  return ctx;
}

export function parsePayloadStage(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  try {
    return { ...ctx, payload: JSON.parse(ctx.raw) };
  } catch {
    return deny(ctx, { reason: 'invalid_json' });
  }
}

export function routeByKindStage(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  return { ...ctx, kind: routeWebhookKind(ctx.eventType) };
}

export function normalizeGenericStage(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  if (ctx.kind !== 'generic') return ctx;
  const normalized = normalizeGitHubWebhook(ctx.eventType, ctx.deliveryId, ctx.payload);
  if (!normalized) return ignored(ctx);
  return {
    ...ctx,
    normalized,
    admissionRepo: { owner: normalized.repoOwner, repo: normalized.repoName },
  };
}

export function validateShapeStage(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  if (ctx.kind !== 'status' && ctx.kind !== 'deployment-family') return ctx;
  const root = objectRoot(ctx.payload);
  const repo = repoFromPayload(root);
  if (ctx.kind === 'status') {
    const sha = statusCommitSha(root);
    if (!repo.owner || !repo.repo || !sha) return ignored(ctx);
    return { ...ctx, admissionRepo: repo, sha };
  }
  const statusRoot = objectOrNull(root.deployment_status);
  const deployment = objectOrNull(root.deployment) ?? objectOrNull(statusRoot?.deployment) ?? {};
  const ref = typeof deployment.ref === 'string' ? deployment.ref : '';
  const sha = typeof deployment.sha === 'string' ? deployment.sha : '';
  if (!repo.owner || !repo.repo || (!ref && !sha)) return ignored(ctx);
  return {
    ...ctx,
    admissionRepo: repo,
    sha,
    deploymentRoot: deployment,
    deploymentStatusRoot: statusRoot,
  };
}

export function filterReposStage(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  const repo = ctx.admissionRepo;
  if (!repo) return ctx;
  const owner = repo.owner.toLowerCase();
  const name = repo.repo.toLowerCase();
  const validForRepo = ctx.matchedRepos.filter(
    (r) => r.owner.toLowerCase() === owner && r.repo.toLowerCase() === name
  );
  if (validForRepo.length === 0) return deny(ctx, { reason: 'repo_not_watched' });
  return { ...ctx, validForRepo };
}

export async function perRepoSpaceAdmissionStage(
  ctx: WebhookAdmissionCtx
): Promise<WebhookAdmissionCtx> {
  const context = ctx.context;
  const repo = ctx.admissionRepo;
  if (!context || !repo) return ctx;
  const spaceEnabled = new Map<string, boolean>();
  for (const watched of ctx.validForRepo) {
    if (!spaceEnabled.has(watched.spaceId)) {
      const spaceConfig = await context.getSpaceConfig(watched.spaceId);
      spaceEnabled.set(watched.spaceId, spaceConfig ? spaceConfig.enabled : true);
    }
  }
  const targets = admittedWatchedRepos(
    ctx.validForRepo,
    repo,
    (id) => spaceEnabled.get(id) ?? true
  );
  if (targets.length === 0) {
    return deny(ctx, { reason: 'admission_empty', deliveryId: ctx.deliveryId });
  }
  return { ...ctx, targets };
}

export function markInactiveDeploymentsStage(ctx: WebhookAdmissionCtx): WebhookAdmissionCtx {
  if (ctx.eventType !== 'deployment_status') return ctx;
  if (ctx.deploymentStatusRoot?.state !== 'inactive') return ctx;
  for (const watched of ctx.targets) ctx.deps.markWebhookReceived(watched.id);
  return deny(ctx, { reason: 'inactive', deliveryId: ctx.deliveryId });
}

export async function resolvePrNumbersStage(
  ctx: WebhookAdmissionCtx
): Promise<WebhookAdmissionCtx> {
  const repo = ctx.admissionRepo;
  if ((ctx.kind !== 'status' && ctx.kind !== 'deployment-family') || !repo) return ctx;
  const kind = ctx.kind === 'status' ? 'status' : 'deployment';
  const resolution = await ctx.deps.resolvePrNumbers(repo, ctx.sha);
  const outcome = classifyPrResolutionOutcome(resolution);
  if (outcome === 'fail-rate-limited') {
    return deny(ctx, { reason: 'rate_limited', deliveryId: ctx.deliveryId, kind });
  }
  if (outcome === 'fail-resolution') {
    return deny(ctx, { reason: 'resolution_failed', deliveryId: ctx.deliveryId, kind });
  }
  if (outcome === 'ignore-no-pull-request') {
    return deny(ctx, { reason: 'no_pull_request', deliveryId: ctx.deliveryId });
  }
  return { ...ctx, prNumbers: resolution.prNumbers };
}

export async function publishPerRepoStage(ctx: WebhookAdmissionCtx): Promise<WebhookAdmissionCtx> {
  const context = ctx.context;
  if (ctx.kind !== 'generic' || !ctx.normalized || !context) return ctx;
  let published = 0;
  for (const watched of ctx.targets) {
    await context.publishEvent(watched.spaceId, ctx.normalized);
    ctx.deps.markWebhookReceived(watched.id);
    published++;
  }
  return received(ctx, published);
}

export async function publishPerPrStage(ctx: WebhookAdmissionCtx): Promise<WebhookAdmissionCtx> {
  const context = ctx.context;
  const repo = ctx.admissionRepo;
  if ((ctx.kind !== 'status' && ctx.kind !== 'deployment-family') || !repo || !context) {
    return ctx;
  }
  const root = objectRoot(ctx.payload);
  const params = {
    repo,
    source: 'webhook' as const,
    deliveryId: ctx.deliveryId,
    rawPayload: ctx.payload,
    sender: root.sender,
    prNumber: 0,
  };
  let published = 0;
  for (const watched of ctx.targets) {
    for (const prNumber of ctx.prNumbers) {
      const normalized =
        ctx.kind === 'status'
          ? normalizeGitHubStatus({ ...params, prNumber, status: root })
          : ctx.eventType === 'deployment'
            ? normalizeGitHubDeployment({ ...params, prNumber, deployment: ctx.deploymentRoot })
            : normalizeGitHubDeploymentStatus({
                ...params,
                prNumber,
                deploymentStatus: root.deployment_status,
                deployment: ctx.deploymentRoot,
              });
      if (!normalized) continue;
      await context.publishEvent(watched.spaceId, normalized);
      published++;
    }
    ctx.deps.markWebhookReceived(watched.id);
  }
  return received(ctx, published);
}

const runAdmission = (superpipe({ halted })('github-webhook-admission') as PipelineAPI)
  .input(['ctx'])
  .pipe(resolveContextStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(admitHeadersStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(matchSignaturesStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(gateCapabilityStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(parsePayloadStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(routeByKindStage, 'ctx', 'ctx')
  .pipe(normalizeGenericStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(validateShapeStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(filterReposStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(perRepoSpaceAdmissionStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(markInactiveDeploymentsStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(resolvePrNumbersStage, 'ctx', 'ctx')
  .pipe('!halted', 'ctx')
  .pipe(publishPerRepoStage, 'ctx', 'ctx')
  .pipe(publishPerPrStage, 'ctx', 'ctx')
  .endAsync('ctx') as (input: WebhookAdmissionCtx) => Promise<WebhookAdmissionCtx>;

export async function runGithubWebhookAdmission(
  deps: WebhookAdmissionDeps,
  input: WebhookAdmissionInput
): Promise<WebhookResponse> {
  const ctx = await runAdmission({
    input,
    deps: { ...deps, verifySignature: deps.verifySignature ?? verifySignature },
    context: null,
    globalConfig: null,
    signature: '',
    eventType: '',
    deliveryId: '',
    raw: '',
    matchedRepos: [],
    payload: undefined,
    kind: null,
    normalized: null,
    admissionRepo: null,
    sha: '',
    deploymentRoot: {},
    deploymentStatusRoot: null,
    validForRepo: [],
    targets: [],
    prNumbers: [],
    response: null,
  });
  return ctx.response ?? webhookDenialResponse({ reason: 'not_started' });
}
