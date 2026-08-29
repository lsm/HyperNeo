import { describe, expect, it } from 'bun:test';
import type { GitHubWatchedRepo } from '../../../../src/lib/external-events/github/github-repository';
import type { NormalizedGitHubEvent } from '../../../../src/lib/external-events/github/github-normalizer';
import {
  matchSignaturesStage,
  runGithubWebhookAdmission,
  validateShapeStage,
  type WebhookAdmissionCtx,
  type WebhookAdmissionDeps,
  type WebhookPrResolution,
} from '../../../../src/lib/external-events/github/webhook-admission-pipeline';

function watched(
  overrides: {
    id: string;
    spaceId: string;
    owner: string;
    repo: string;
  } & Partial<GitHubWatchedRepo>
): GitHubWatchedRepo {
  return { enabled: true, webhookSecret: 'secret-a', ...overrides } as GitHubWatchedRepo;
}

const defaultRepos = () => [
  watched({ id: 'w1', spaceId: 'space-1', owner: 'acme', repo: 'widgets' }),
  watched({ id: 'w2', spaceId: 'space-2', owner: 'acme', repo: 'widgets' }),
];

const emptyResolution: WebhookPrResolution = {
  prNumbers: [],
  rateLimited: false,
  resolutionFailed: false,
};

interface Harness {
  deps: Required<WebhookAdmissionDeps>;
  state: {
    published: Array<{ spaceId: string; event: NormalizedGitHubEvent }>;
    marked: string[];
    verifyCalls: Array<{ raw: string; signature: string; secret: string }>;
    resolved: Array<{ owner: string; repo: string; sha: string }>;
  };
}

function makeHarness(
  options: {
    repos?: GitHubWatchedRepo[];
    spaces?: Record<string, boolean>;
    globallyEnabled?: boolean;
    started?: boolean;
    resolutions?: WebhookPrResolution[];
  } = {}
): Harness {
  const state: Harness['state'] = { published: [], marked: [], verifyCalls: [], resolved: [] };
  const resolutions = options.resolutions ?? [{ ...emptyResolution, prNumbers: [7] }];
  const deps: Required<WebhookAdmissionDeps> = {
    getContext: async () =>
      options.started === false
        ? null
        : {
            getGlobalConfig: async () => ({
              source: 'github',
              globallyEnabled: options.globallyEnabled ?? true,
              capabilities: {},
            }),
            getSpaceConfig: async (spaceId: string) => ({
              spaceId,
              source: 'github',
              enabled: options.spaces?.[spaceId] ?? true,
              settings: {},
            }),
            publishEvent: async (spaceId: string, event: NormalizedGitHubEvent) => {
              state.published.push({ spaceId, event });
            },
          },
    listWebhookValidationRepos: () => options.repos ?? defaultRepos(),
    verifySignature: async (raw, signature, secret) => {
      state.verifyCalls.push({ raw, signature, secret });
      return signature === `sha256=${secret}`;
    },
    resolvePrNumbers: async (repo, sha) => {
      state.resolved.push({ owner: repo.owner, repo: repo.repo, sha });
      return resolutions[state.resolved.length - 1] ?? emptyResolution;
    },
    markWebhookReceived: (repoId: string) => {
      state.marked.push(repoId);
    },
  };
  return { deps, state };
}

const repository = { name: 'widgets', owner: { login: 'acme' }, full_name: 'acme/widgets' };
const sender = { login: 'octocat', type: 'User' };

const issueCommentPayload = {
  action: 'created',
  issue: {
    number: 42,
    pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/42' },
  },
  comment: {
    id: 9001,
    body: 'ship it',
    user: sender,
    html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-9001',
  },
  repository,
  sender,
};

const statusPayload = { state: 'success', sha: 'abc123', name: 'ci', repository, sender };
const deploymentPayload = {
  action: 'created',
  deployment: { id: 7, ref: 'main', sha: 'abc123', environment: 'prod' },
  repository,
  sender,
};
const deploymentStatusPayload = {
  action: 'created',
  deployment_status: { id: 9, state: 'success', deployment: { id: 7, ref: 'main', sha: 'abc123' } },
  repository,
  sender,
};

function admissionInput(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    signature: 'sha256=secret-a',
    eventType: 'issue_comment',
    deliveryId: 'delivery-1',
    raw: JSON.stringify(payload),
    ...overrides,
  };
}

describe('github webhook admission precedence', () => {
  it('halts 503 before headers when the extension context is missing', async () => {
    const { deps, state } = makeHarness({ started: false });
    const response = await runGithubWebhookAdmission(deps, admissionInput(issueCommentPayload));
    expect(response).toEqual({ status: 503, body: { error: 'GitHub extension not started' } });
    expect(state.verifyCalls).toEqual([]);
  });

  it('halts 401 on a missing signature and 400 on missing event headers', async () => {
    const { deps } = makeHarness();
    const noSignature = await runGithubWebhookAdmission(
      deps,
      admissionInput(issueCommentPayload, { signature: null })
    );
    expect(noSignature).toEqual({ status: 401, body: { error: 'Missing signature header' } });
    const noEvent = await runGithubWebhookAdmission(
      deps,
      admissionInput(issueCommentPayload, { eventType: null })
    );
    expect(noEvent).toEqual({ status: 400, body: { error: 'Missing GitHub event headers' } });
  });

  it('validates signatures before the capability gate rejects', async () => {
    const { deps, state } = makeHarness({
      globallyEnabled: false,
      repos: [
        watched({
          id: 'w1',
          spaceId: 'space-1',
          owner: 'acme',
          repo: 'widgets',
          webhookSecret: 'secret-b',
        }),
      ],
    });
    const response = await runGithubWebhookAdmission(deps, admissionInput(issueCommentPayload));
    expect(response).toEqual({ status: 401, body: { error: 'Invalid signature' } });
    expect(state.verifyCalls.map((c) => c.secret)).toEqual(['secret-b']);
  });

  it('ignores with 202 after a valid signature when webhooks are disabled', async () => {
    const { deps, state } = makeHarness({ globallyEnabled: false });
    const response = await runGithubWebhookAdmission(deps, admissionInput(issueCommentPayload));
    expect(response).toEqual({
      status: 202,
      body: { message: 'Event ignored', reason: 'github_extension_disabled' },
    });
    expect(state.published).toEqual([]);
  });

  it('halts 400 on an unparseable payload', async () => {
    const { deps } = makeHarness();
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput(issueCommentPayload, { raw: 'not json' })
    );
    expect(response).toEqual({ status: 400, body: { error: 'Invalid JSON payload' } });
  });
});

describe('generic webhook path', () => {
  it('publishes to every admitted space and marks receipt', async () => {
    const { deps, state } = makeHarness();
    const response = await runGithubWebhookAdmission(deps, admissionInput(issueCommentPayload));
    expect(response).toEqual({
      status: 200,
      body: { message: 'Webhook received', deliveryId: 'delivery-1', spaces: 2 },
    });
    expect(state.published.map((p) => p.spaceId)).toEqual(['space-1', 'space-2']);
    expect(state.published.every((p) => p.event.eventType === 'issue_comment')).toBe(true);
    expect(state.marked).toEqual(['w1', 'w2']);
  });

  it('ignores unknown event kinds with 202', async () => {
    const { deps } = makeHarness();
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput({}, { eventType: 'push' })
    );
    expect(response).toEqual({
      status: 202,
      body: { message: 'Event ignored', deliveryId: 'delivery-1' },
    });
  });

  it('halts 404 when no signature-matched repo matches the payload repo', async () => {
    const { deps } = makeHarness({
      repos: [watched({ id: 'w1', spaceId: 'space-1', owner: 'other', repo: 'gadgets' })],
    });
    const response = await runGithubWebhookAdmission(deps, admissionInput(issueCommentPayload));
    expect(response).toEqual({ status: 404, body: { error: 'Repository is not watched' } });
  });

  it('responds 200 with zero spaces when every space admission fails', async () => {
    const { deps, state } = makeHarness({ spaces: { 'space-1': false, 'space-2': false } });
    const response = await runGithubWebhookAdmission(deps, admissionInput(issueCommentPayload));
    expect(response).toEqual({
      status: 200,
      body: { message: 'Webhook received', deliveryId: 'delivery-1', spaces: 0 },
    });
    expect(state.published).toEqual([]);
    expect(state.marked).toEqual([]);
  });
});

describe('status webhook path', () => {
  it('ignores payloads without a commit sha', async () => {
    const { deps } = makeHarness();
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput({ state: 'success', repository }, { eventType: 'status' })
    );
    expect(response).toEqual({
      status: 202,
      body: { message: 'Event ignored', deliveryId: 'delivery-1' },
    });
  });

  it('falls back to commit.sha for shape validation', async () => {
    const { deps, state } = makeHarness();
    const payload = { ...statusPayload, sha: undefined, commit: { sha: 'fallback-sha' } };
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput(payload, { eventType: 'status' })
    );
    expect(response).toEqual({
      status: 200,
      body: { message: 'Webhook received', deliveryId: 'delivery-1', spaces: 2 },
    });
    expect(state.resolved).toEqual([{ owner: 'acme', repo: 'widgets', sha: 'fallback-sha' }]);
  });

  it('ignores with 202 when no pull request matches', async () => {
    const { deps } = makeHarness({ resolutions: [emptyResolution] });
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput(statusPayload, { eventType: 'status' })
    );
    expect(response).toEqual({
      status: 202,
      body: { message: 'Event ignored', deliveryId: 'delivery-1', reason: 'no_pull_request' },
    });
  });

  it('halts 503 when status PR resolution is rate limited or fails', async () => {
    const limited = makeHarness({ resolutions: [{ ...emptyResolution, rateLimited: true }] });
    expect(
      await runGithubWebhookAdmission(
        limited.deps,
        admissionInput(statusPayload, { eventType: 'status' })
      )
    ).toEqual({
      status: 503,
      body: { error: 'Status PR resolution skipped — rate limited', deliveryId: 'delivery-1' },
    });
    const failed = makeHarness({ resolutions: [{ ...emptyResolution, resolutionFailed: true }] });
    expect(
      await runGithubWebhookAdmission(
        failed.deps,
        admissionInput(statusPayload, { eventType: 'status' })
      )
    ).toEqual({
      status: 503,
      body: { error: 'Status PR resolution failed', deliveryId: 'delivery-1' },
    });
  });

  it('publishes one status event per target and pull request', async () => {
    const { deps, state } = makeHarness({
      resolutions: [{ prNumbers: [7, 8], rateLimited: false, resolutionFailed: false }],
    });
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput(statusPayload, { eventType: 'status' })
    );
    expect(response).toEqual({
      status: 200,
      body: { message: 'Webhook received', deliveryId: 'delivery-1', spaces: 4 },
    });
    expect(state.published.map((p) => p.event.prNumber)).toEqual([7, 8, 7, 8]);
    expect(state.published.every((p) => p.event.eventType === 'status')).toBe(true);
    expect(state.marked).toEqual(['w1', 'w2']);
  });
});

describe('deployment webhook path', () => {
  it('ignores payloads without ref and sha', async () => {
    const { deps } = makeHarness();
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput(
        { action: 'created', deployment: { id: 7 }, repository, sender },
        { eventType: 'deployment' }
      )
    );
    expect(response).toEqual({
      status: 202,
      body: { message: 'Event ignored', deliveryId: 'delivery-1' },
    });
  });

  it('marks targets and ignores inactive deployment statuses without resolving PRs', async () => {
    const { deps, state } = makeHarness();
    const payload = {
      action: 'created',
      deployment_status: { id: 9, state: 'inactive', deployment: deploymentPayload.deployment },
      repository,
      sender,
    };
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput(payload, { eventType: 'deployment_status' })
    );
    expect(response).toEqual({
      status: 202,
      body: { message: 'Event ignored', deliveryId: 'delivery-1', reason: 'inactive' },
    });
    expect(state.marked).toEqual(['w1', 'w2']);
    expect(state.resolved).toEqual([]);
  });

  it('halts 503 when deployment PR resolution is rate limited or fails', async () => {
    const limited = makeHarness({ resolutions: [{ ...emptyResolution, rateLimited: true }] });
    expect(
      await runGithubWebhookAdmission(
        limited.deps,
        admissionInput(deploymentPayload, { eventType: 'deployment' })
      )
    ).toEqual({
      status: 503,
      body: { error: 'Deployment PR resolution skipped — rate limited', deliveryId: 'delivery-1' },
    });
    const failed = makeHarness({ resolutions: [{ ...emptyResolution, resolutionFailed: true }] });
    expect(
      await runGithubWebhookAdmission(
        failed.deps,
        admissionInput(deploymentPayload, { eventType: 'deployment' })
      )
    ).toEqual({
      status: 503,
      body: { error: 'Deployment PR resolution failed', deliveryId: 'delivery-1' },
    });
  });

  it('publishes deployment events per target and pull request', async () => {
    const { deps, state } = makeHarness();
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput(deploymentPayload, { eventType: 'deployment' })
    );
    expect(response).toEqual({
      status: 200,
      body: { message: 'Webhook received', deliveryId: 'delivery-1', spaces: 2 },
    });
    expect(state.published.map((p) => p.event.eventType)).toEqual(['deployment', 'deployment']);
    expect(state.marked).toEqual(['w1', 'w2']);
  });

  it('resolves the deployment through deployment_status.deployment when nested', async () => {
    const { deps, state } = makeHarness();
    const response = await runGithubWebhookAdmission(
      deps,
      admissionInput(deploymentStatusPayload, { eventType: 'deployment_status' })
    );
    expect(response).toEqual({
      status: 200,
      body: { message: 'Webhook received', deliveryId: 'delivery-1', spaces: 2 },
    });
    expect(state.published.every((p) => p.event.eventType === 'deployment_status')).toBe(true);
    expect(state.published.map((p) => p.event.payload?.deploymentId)).toEqual([7, 7]);
    expect(state.resolved).toEqual([{ owner: 'acme', repo: 'widgets', sha: 'abc123' }]);
  });
});

function stageCtx(partial: Partial<WebhookAdmissionCtx>): WebhookAdmissionCtx {
  const { deps } = makeHarness();
  return {
    input: { signature: 'sha256=secret-a', eventType: 'status', deliveryId: 'delivery-1', raw: '' },
    deps: { ...deps, verifySignature: async () => false },
    context: null,
    globalConfig: null,
    signature: 'sha256=secret-a',
    eventType: 'status',
    deliveryId: 'delivery-1',
    matchedRepos: [],
    payload: undefined,
    kind: 'status',
    normalized: null,
    admissionRepo: null,
    sha: '',
    deploymentRoot: {},
    deploymentStatusRoot: null,
    validForRepo: [],
    targets: [],
    prNumbers: [],
    response: null,
    ...partial,
  };
}

describe('matchSignaturesStage', () => {
  it('keeps only repos whose secret verifies and halts 401 when none match', async () => {
    const repos = [
      watched({
        id: 'w1',
        spaceId: 's1',
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'secret-a',
      }),
      watched({
        id: 'w2',
        spaceId: 's2',
        owner: 'acme',
        repo: 'widgets',
        webhookSecret: 'secret-b',
      }),
      watched({ id: 'w3', spaceId: 's3', owner: 'acme', repo: 'widgets', webhookSecret: null }),
    ];
    const verify = async (raw: string, signature: string, secret: string) =>
      signature === `sha256=${secret}` && raw === 'body';
    const matched = await matchSignaturesStage(
      stageCtx({
        deps: {
          ...stageCtx({}).deps,
          listWebhookValidationRepos: () => repos,
          verifySignature: verify,
        },
        input: { signature: 'sha256=secret-a', eventType: 'status', deliveryId: 'd', raw: 'body' },
      })
    );
    expect(matched.matchedRepos.map((r) => r.id)).toEqual(['w1']);
    const denied = await matchSignaturesStage(
      stageCtx({
        deps: { ...stageCtx({}).deps, listWebhookValidationRepos: () => repos },
        input: { signature: 'sha256=secret-a', eventType: 'status', deliveryId: 'd', raw: 'body' },
      })
    );
    expect(denied.response).toEqual({ status: 401, body: { error: 'Invalid signature' } });
  });
});

describe('validateShapeStage', () => {
  it('extracts the sha for status and the deployment chain for deployment-family kinds', () => {
    const status = validateShapeStage(
      stageCtx({ kind: 'status', payload: { sha: 'abc', repository } })
    );
    expect(status.admissionRepo).toEqual({ owner: 'acme', repo: 'widgets' });
    expect(status.sha).toBe('abc');
    const deployment = validateShapeStage(
      stageCtx({
        kind: 'deployment-family',
        eventType: 'deployment',
        payload: { deployment: { ref: 'main', sha: 'dep-sha' }, repository },
      })
    );
    expect(deployment.sha).toBe('dep-sha');
    expect(deployment.deploymentRoot).toEqual({ ref: 'main', sha: 'dep-sha' });
    const nested = validateShapeStage(
      stageCtx({
        kind: 'deployment-family',
        eventType: 'deployment_status',
        payload: {
          deployment_status: { state: 'success', deployment: { ref: 'main', sha: 'nest-sha' } },
          repository,
        },
      })
    );
    expect(nested.sha).toBe('nest-sha');
    expect(nested.deploymentStatusRoot?.state).toBe('success');
  });

  it('halts 202 when the status shape is incomplete', () => {
    const denied = validateShapeStage(stageCtx({ kind: 'status', payload: { repository } }));
    expect(denied.response).toEqual({
      status: 202,
      body: { message: 'Event ignored', deliveryId: 'delivery-1' },
    });
  });
});
