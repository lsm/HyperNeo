/**
 * Unit tests for the get_pr_diff handler orchestration.
 *
 * The handler fetches a GitHub PR diff server-side (authed, no shell) — PR
 * metadata plus a paginated changed-file list with per-file patches. These
 * tests cover the pure orchestration logic (`getPrDiff`), the host guard
 * (`isAllowedGhHost`), and the shape mappers (`mapPrMeta` / `mapPrFile`) by
 * injecting fake deps — no `gh` is spawned. The real authed `gh` wiring
 * (`buildGhGetPrDiffDeps`) reuses the trusted `runGhJson` / `buildGitHubLookupEnv`
 * path (the same credential path as the github connector and `pr_ready`); auth
 * correctness relies on that reuse and is intentionally not re-tested here.
 */

import { describe, expect, it } from 'bun:test';
import {
  getPrDiff,
  isAllowedGhHost,
  isSamePrIdentity,
  mapPrMeta,
  mapPrFile,
  type GetPrDiffDeps,
  type GetPrDiffDepsError,
  type RawPrMeta,
  type RawPrFile,
} from '../../../../src/lib/space/tools/get-pr-diff-handler';

const PR_URL = 'https://github.com/owner/repo/pull/42';

const RAW_META: RawPrMeta = {
  html_url: 'https://github.com/owner/repo/pull/42',
  title: 'Add get_pr_diff',
  state: 'open',
  draft: false,
  mergeable: true,
  mergeable_state: 'clean',
  additions: 10,
  deletions: 2,
  changed_files: 2,
  base: { sha: 'basesha', ref: 'main' },
  head: { sha: 'headsha', ref: 'feature' },
};

const RAW_FILE_A: RawPrFile = {
  filename: 'src/a.ts',
  status: 'modified',
  additions: 5,
  deletions: 1,
  patch: '@@ -1,2 +1,3 @@\n line\n+added',
};
const RAW_FILE_B: RawPrFile = {
  filename: 'bin/logo.png',
  status: 'added',
  additions: 0,
  deletions: 0,
  // no patch — binary file
};
const RAW_FILE_RENAMED: RawPrFile = {
  filename: 'src/new-name.ts',
  status: 'renamed',
  additions: 0,
  deletions: 0,
  previous_filename: 'src/old-name.ts',
  // pure renames carry no patch
};

type MetaResp = { ok: true; data: RawPrMeta } | ({ ok: false } & GetPrDiffDepsError);
type PageResp = { ok: true; data: RawPrFile[] } | ({ ok: false } & GetPrDiffDepsError);

/** Build fake deps with a scripted meta response + scripted file-page responses. */
function makeDeps(
  metaResp: MetaResp,
  pageResps: PageResp[],
  opts?: { enterpriseHost?: string }
): { deps: GetPrDiffDeps; pagesRequested: () => number } {
  const state = { pages: 0 };
  let i = 0;
  const deps: GetPrDiffDeps = {
    enterpriseHost: opts?.enterpriseHost,
    fetchPrMeta: async () => metaResp,
    fetchPrFilesPage: async () => {
      state.pages++;
      return pageResps[i++] ?? { ok: true, data: [] };
    },
  };
  return { deps, pagesRequested: () => state.pages };
}

/** A full 100-file page, for pagination / truncation cases. */
function fullPage(prefix: string): RawPrFile[] {
  return Array.from(
    { length: 100 },
    (_, k): RawPrFile => ({
      filename: `${prefix}${k}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -0,0 +1 @@\n+added',
    })
  );
}

describe('get_pr_diff handler — getPrDiff', () => {
  it('fetches meta + a single page of files and maps them', async () => {
    const { deps, pagesRequested } = makeDeps(
      { ok: true, data: RAW_META },
      [{ ok: true, data: [RAW_FILE_A, RAW_FILE_B, RAW_FILE_RENAMED] }] // short page → stop
    );
    const result = await getPrDiff({ prUrl: PR_URL }, deps);

    expect(result.success).toBe(true);
    expect(result.pr).toEqual({
      url: 'https://github.com/owner/repo/pull/42',
      title: 'Add get_pr_diff',
      state: 'open',
      draft: false,
      base: { sha: 'basesha', ref: 'main' },
      head: { sha: 'headsha', ref: 'feature' },
      mergeable: true,
      mergeableState: 'clean',
      additions: 10,
      deletions: 2,
      changedFiles: 2,
    });
    expect(result.files).toHaveLength(3);
    expect(result.files![0].patch).toBe(RAW_FILE_A.patch);
    expect(result.files![1].patch).toBeUndefined(); // binary → no patch
    expect(result.files![2].patch).toBeUndefined(); // pure rename → no patch
    expect(result.files![2].previousFilename).toBe('src/old-name.ts'); // rename → old path
    expect(result.truncated).toBe(false);
    expect(result.filesWithoutPatch).toBe(2); // binary + pure rename have no patch
    expect(pagesRequested()).toBe(1);
  });

  it('paginates until a short page, accumulating files', async () => {
    const { deps, pagesRequested } = makeDeps({ ok: true, data: RAW_META }, [
      { ok: true, data: fullPage('a') }, // 100 → continue
      { ok: true, data: [RAW_FILE_A] }, // 1 → last page
    ]);
    const result = await getPrDiff({ prUrl: PR_URL }, deps);
    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(pagesRequested()).toBe(2);
  });

  it('stops on an empty page (file count an exact multiple of page size)', async () => {
    const { deps, pagesRequested } = makeDeps({ ok: true, data: RAW_META }, [
      { ok: true, data: fullPage('a') }, // 100 → continue
      { ok: true, data: [] }, // empty → stop
    ]);
    const result = await getPrDiff({ prUrl: PR_URL }, deps);
    expect(result.files).toHaveLength(100);
    expect(pagesRequested()).toBe(2);
  });

  it('marks truncated only when changedFiles exceeds the fetched count', async () => {
    // 31 full pages available; the loop stops at 30 pages (3000 files = cap).
    // PR metadata reports 3500 changed files → some were omitted → truncated.
    const bigMeta: RawPrMeta = { ...RAW_META, changed_files: 3500 };
    const pages = Array.from({ length: 31 }, () => ({ ok: true, data: fullPage('a') }));
    const { deps } = makeDeps({ ok: true, data: bigMeta }, pages);
    const result = await getPrDiff({ prUrl: PR_URL }, deps);
    expect(result.success).toBe(true);
    expect(result.files!.length).toBe(3000);
    expect(result.truncated).toBe(true);
  });

  it('does NOT mark truncated at the cap when changedFiles equals the fetched count', async () => {
    // PR reports exactly 3000 changed files; all 3000 were fetched → complete.
    const exactMeta: RawPrMeta = { ...RAW_META, changed_files: 3000 };
    const pages = Array.from({ length: 31 }, () => ({ ok: true, data: fullPage('a') }));
    const { deps } = makeDeps({ ok: true, data: exactMeta }, pages);
    const result = await getPrDiff({ prUrl: PR_URL }, deps);
    expect(result.files!.length).toBe(3000);
    expect(result.truncated).toBe(false);
  });

  it('errors on a malformed PR URL before fetching anything', async () => {
    const { deps } = makeDeps({ ok: true, data: RAW_META }, []);
    const result = await getPrDiff({ prUrl: 'not-a-url' }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unable to parse GitHub PR URL');
  });

  it('refuses a non-GitHub host before any credentialled request (SSRF guard)', async () => {
    const { deps, pagesRequested } = makeDeps({ ok: true, data: RAW_META }, [
      { ok: true, data: [RAW_FILE_A] },
    ]);
    const result = await getPrDiff({ prUrl: 'https://evil.example.com/o/r/pull/1' }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Refusing get_pr_diff for host 'evil.example.com'");
    // No gh spawned.
    expect(pagesRequested()).toBe(0);
  });

  it('allows github.com and the configured enterprise host', async () => {
    // github.com always allowed.
    const gh = makeDeps({ ok: true, data: RAW_META }, [{ ok: true, data: [RAW_FILE_A] }]);
    expect((await getPrDiff({ prUrl: PR_URL }, gh.deps)).success).toBe(true);
    // Configured enterprise host allowed.
    const ent = makeDeps({ ok: true, data: RAW_META }, [{ ok: true, data: [RAW_FILE_A] }], {
      enterpriseHost: 'gh.acme.corp',
    });
    expect((await getPrDiff({ prUrl: 'https://gh.acme.corp/o/r/pull/7' }, ent.deps)).success).toBe(
      true
    );
  });

  it('propagates a fetchPrMeta failure', async () => {
    const { deps } = makeDeps({ ok: false, error: 'HTTP 404: Not Found' }, []);
    const result = await getPrDiff({ prUrl: PR_URL }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
    expect(result.files).toBeUndefined();
  });

  it('propagates a fetchPrFilesPage failure mid-pagination', async () => {
    const { deps } = makeDeps({ ok: true, data: RAW_META }, [
      { ok: false, error: 'HTTP 500: server error' },
    ]);
    const result = await getPrDiff({ prUrl: PR_URL }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });

  it('preserves rate-limit backoff guidance on a meta failure', async () => {
    const { deps } = makeDeps(
      { ok: false, error: 'HTTP 403: rate limit exceeded', retryable: true, retryAfterMs: 12_000 },
      []
    );
    const result = await getPrDiff({ prUrl: PR_URL }, deps);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(12_000);
  });

  it('preserves rate-limit backoff guidance on a files-page failure', async () => {
    const { deps } = makeDeps({ ok: true, data: RAW_META }, [
      { ok: false, error: 'secondary rate limit', retryable: true, retryAfterMs: 60_000 },
    ]);
    const result = await getPrDiff({ prUrl: PR_URL }, deps);
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(60_000);
  });
});

describe('get_pr_diff handler — isAllowedGhHost', () => {
  it('allows github.com (case-insensitive) and the configured enterprise host', () => {
    expect(isAllowedGhHost('github.com')).toBe(true);
    expect(isAllowedGhHost('GitHub.Com')).toBe(true);
    expect(isAllowedGhHost('gh.acme.corp', 'gh.acme.corp')).toBe(true);
    expect(isAllowedGhHost('GH.Acme.Corp', 'gh.acme.corp')).toBe(true);
  });

  it('rejects arbitrary hosts and non-matching enterprise hosts', () => {
    expect(isAllowedGhHost('evil.example.com')).toBe(false);
    expect(isAllowedGhHost('evil.example.com', 'gh.acme.corp')).toBe(false);
    expect(isAllowedGhHost('github.com.evil.com')).toBe(false);
  });
});

describe('get_pr_diff handler — isSamePrIdentity', () => {
  // The wiring uses this to bind a caller-supplied prUrl to the run PR, so a
  // prompt-injected reviewer can't read a different (e.g. other private) repo.
  const A = 'https://github.com/owner/repo/pull/42';
  it('matches the same PR (case-insensitive host/owner/repo)', () => {
    expect(isSamePrIdentity(A, 'https://github.com/owner/repo/pull/42')).toBe(true);
    expect(isSamePrIdentity(A, 'https://GITHUB.com/Owner/REPO/pull/42')).toBe(true);
  });
  it('rejects a different owner, repo, or number (cross-PR guard)', () => {
    expect(isSamePrIdentity(A, 'https://github.com/owner/repo/pull/43')).toBe(false); // number
    expect(isSamePrIdentity(A, 'https://github.com/owner/other-repo/pull/42')).toBe(false); // repo
    expect(isSamePrIdentity(A, 'https://github.com/attacker/repo/pull/42')).toBe(false); // owner
  });
  it('rejects malformed URLs', () => {
    expect(isSamePrIdentity(A, 'not-a-url')).toBe(false);
    expect(isSamePrIdentity('not-a-url', A)).toBe(false);
  });
});

describe('get_pr_diff handler — mappers', () => {
  it('mapPrMeta maps snake_case fields and falls back to the supplied URL', () => {
    const mapped = mapPrMeta({ ...RAW_META, html_url: undefined }, PR_URL);
    expect(mapped.url).toBe(PR_URL);
    expect(mapped.title).toBe('Add get_pr_diff');
    expect(mapped.base).toEqual({ sha: 'basesha', ref: 'main' });
    expect(mapped.head).toEqual({ sha: 'headsha', ref: 'feature' });
  });

  it('mapPrMeta preserves a null mergeable (GitHub still computing)', () => {
    const mapped = mapPrMeta({ mergeable: null }, PR_URL);
    expect(mapped.mergeable).toBeNull();
    expect(mapped.mergeableState).toBeNull();
  });

  it('mapPrMeta defaults missing numeric / ref fields to empty values', () => {
    const mapped = mapPrMeta({}, PR_URL);
    expect(mapped.additions).toBe(0);
    expect(mapped.deletions).toBe(0);
    expect(mapped.changedFiles).toBe(0);
    expect(mapped.draft).toBe(false);
    expect(mapped.base).toEqual({ sha: '', ref: '' });
    expect(mapped.head).toEqual({ sha: '', ref: '' });
  });

  it('mapPrFile omits patch when absent or empty, keeps it otherwise', () => {
    expect(mapPrFile(RAW_FILE_B).patch).toBeUndefined();
    expect(mapPrFile({ ...RAW_FILE_A, patch: '' }).patch).toBeUndefined();
    expect(mapPrFile(RAW_FILE_A).patch).toBe(RAW_FILE_A.patch);
  });

  it('mapPrFile surfaces previousFilename only when present', () => {
    expect(mapPrFile(RAW_FILE_RENAMED).previousFilename).toBe('src/old-name.ts');
    expect(mapPrFile(RAW_FILE_A).previousFilename).toBeUndefined();
    expect(
      mapPrFile({ ...RAW_FILE_RENAMED, previous_filename: '' }).previousFilename
    ).toBeUndefined();
  });
});
