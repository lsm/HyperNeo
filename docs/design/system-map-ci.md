# Enforce system-map reading in CI

Part of #10814.

## Evidence

### Do clients load the rule?

The root `CLAUDE.md` is a symlink to `AGENTS.md`, so the text is shared; delivery still differs by client.

| Client | Config/code evidence | Recent session evidence and limit |
| --- | --- | --- |
| Codex | `packages/daemon/src/lib/drivers/codex-desktop-adapter.ts:1358-1365` starts the thread in the worktree `cwd`; `packages/daemon/src/lib/drivers/codex-feed.ts:58-66` recognizes Codex's `# AGENTS.md instructions` blocks. | On 2026-11-23, 28 HyperNeo-workdir rollouts had AGENTS blocks, 14 had HyperNeo project text, and 7 had the current system-map rule. Codex does load project instructions, but not uniformly in this sample. |
| Claude Code | The symlink is the project-instruction entry point. | This Claude Code session received the root file and nested package files as system reminders. A three-day local transcript search found 254 sessions with client instruction context and 138 with the current rule. |
| HyperNeo worker | `packages/daemon/src/lib/agent/query-options-builder.ts:645-646` passes session or global `settingSources`; `packages/shared/src/types/settings.ts:263-266` defaults to `user,project,local`. An explicit session override can still disable them. | Active worker processes used `user,project,local`; this worker received the root and nested rules. Default workers load the files, but config presence does not prove model attention. |
| Resident Neo | `packages/daemon/src/lib/neo/session-config.ts:8-24` sets `settingSources: []`. | Neo does not automatically load project instructions. It must receive the rule in its prompt or read the file explicitly; worker evidence does not cover Neo itself. |

I could not verify other machines, every historical session, private sessions without retained transcripts, or whether a model actually read and applied text present in context.

### Recent PR proof

I audited the 60 newest merged PRs on 2026-11-23: 54 with a non-inert-doc change (“code”) and 6 design-only PRs. Client comes from each PR's `Agent:` line; `via Claude` remains separate rather than being guessed to mean Claude Code. Proof means a #10836 record or an explicit command in the PR body, comments, or reviews.

| Recorded client | Code with proof | Design with proof |
| --- | ---: | ---: |
| Codex | 25 / 47 | 1 / 1 |
| Claude Code | 2 / 3 | — |
| HyperNeo | 0 / 1 | 3 / 5 |
| Claude (unspecified) | 0 / 3 | — |
| **Total** | **27 / 54** | **4 / 6** |

Thirty PRs had #10836 records. The additional design proof was a reviewer-run `where` on #11493, not an author record. A search of recent local Claude Code and Codex transcripts found no further run proof for the 29 uncovered PRs.

The uncovered PRs were:

- Mapped code (14): #11622, #11610, #11602, #11598, #11593, #11566, #11562, #11554, #11548, #11546, #11545, #11513, #11509, #11501.
- Code with no mapped source (13): #11612, #11607, #11600, #11591, #11590, #11573, #11532, #11527, #11517, #11515, #11511, #11500, #11491.
- Design (2): #11550 and #11542.

No uncovered PR recorded why the command was absent. Fifteen had no mapped source diff, consistent with treating the tool as code-only, but that motive is unproven. The 14 mapped-code cases have no recorded explanation; #11622 was freshly merged and may only lack its follow-up comment. Uneven Codex instruction delivery is a possible contributor, not a verified cause for any listed PR. Missing evidence does not prove a run was skipped: runs on other machines or outside retained logs remain unverifiable.

### Impact noise measurement

For the earlier sample of 40 merged code PRs (#11521–#11612), I checked out each squash commit and ran `bun run system-map impact --diff <merge-commit>^`. The unique name-linked outside files had median 0 and maximum 80 (#11531); 25 PRs had zero. Importer references had median 2.5 and maximum 278, and can repeat a file across planned paths. Eleven PRs had no mapped source diff, and none had an unmapped planned source. Median/max invocation time was 0.26/0.54 s. A full current `map` run took 2.95 s.

This supports gating the explicitly listed name-linked peers and deleted sources, not importer counts.

## Required reading

The tool has four levels; none is a general function call graph.

| Work | Required reading |
| --- | --- |
| Every design | `map` for package/component/operation placement; `impact <planned files>` once the plan names files. |
| Every code change | `impact --diff` for changed files, their importers, name-linked peers, and nearby table/event names. If the diff has no mapped sources, use `map` to locate the owning package/component instead. Use `map --diff` when component placement is also changing or unclear. |
| An operation, RPC, event, or table contract | `where <name>` for its definitions and counterpart files. This applies to code and design. |
| A pipeline runner | `routes <module> <export>` for its ordered runner steps. This applies to code and design. |

`impact` follows static imports and name links, not arbitrary function calls. CI can require minimum `map`/`impact` claims, but cannot infer every `where` name or `routes` runner from design prose; those remain author/reviewer obligations.

## Smallest CI enforcement

Extend the existing PR-only `changes` job, which already runs for docs-only PRs. Do not put this in `check`, which docs skip. Add no job, service, scheduled index, or PR-comment bot.

The existing step first computes and saves the NUL-delimited two-dot PR diff at the merge commit. New steps then set up Bun, fetch `refs/pull/<n>/head`, check out the exact PR head SHA, install the locked dependencies, and run a `scripts/system-map-impact.ts` wrapper. The wrapper reuses `isSource`, `impact`, `formatImpact`, and the repository loader. It runs full `map` plus `impact` on the saved changed-file list at that head. Using the saved merge diff avoids both a full-history fetch and reverse changes from an advanced base.

CI derives a sorted required-path set from unique `Impact.owned[].peers[]` paths and `known: false` planned paths. Importers and nearby table/event lists stay informational. Analyzer or diff failure fails the step; neither can become an empty pass.

### PR-body contract

A mapped-code PR needs an `impact` read claim. A PR changing `docs/design/` needs `map` and `impact` claims, even though its own document is unmapped; the design author ran `impact` on planned files, not just the Markdown. A mixed PR needs both. Every non-exempt PR uses one visible block, including zero-peer results:

````markdown
```system-map-impact
{"version":1,"head":"<full PR head SHA>","base":"<full base SHA>","read":["map","impact"]}
{"path":"packages/daemon/src/lib/neo/service.ts","reason":"Checked the event listener; its contract is unchanged."}
```
````

`where` and `routes` may also appear in `read`. CI validates required claims, the current head/base, and one non-empty reason per required path. It rejects missing, extra, or duplicate paths, empty reasons, and unknown versions. `--print` generates the local block; CI prints its exact required block in a collapsed log with the full reports. No PR comment is created.

A validation failure produces one error: `System map check failed: <read/path/reason counts>; head/base <current|stale>. Run system-map-impact.ts --print and use the collapsed CI report and replacement block; author read entries are claims.` Analyzer failures instead report the command and head that failed.

Tests-only, native-only, scripts-only, dependency-only, and non-design inert-doc PRs need no body block. A maintainer-controlled `revert` label also waives it. These exemptions waive only the attestation: CI still executes `map` and `impact` on the head. Native files in a mixed mapped-source PR remain ignored, deleted mapped sources require entries, and a dependency bump with mapped source is not exempt.

Add `edited` to the existing `pull_request` trigger while retaining `opened`, `synchronize`, and `reopened`. Body edits revalidate; new heads invalidate the block. The wrapper reads event data and makes no GitHub API calls, so fork PRs need no secrets. Existing checkout and fetch work adds one small head fetch; analysis is about 3 s from the measured `map` plus sub-second `impact`, inside the current three-minute job. Bun and dependency setup time was not measured.

### What CI proves

The CI log proves that `map` and `impact` completed on the exact PR head and that the body accounts for the computed path set. `read` entries and reasons are author claims: CI cannot prove the author read any output, ran the same commands locally, or used the result. Design planned-file analysis and `where`/`routes` coverage are likewise claims, not head executions inferred by CI.

A false positive gets a reason explaining the wrong link. Missing links still need human feedback. Replace routine #10836 comments with the CI log and body block; keep that issue for missed/wrong links and runtime problems.

Implementation tests cover peer de-duplication, ignored importers, deleted sources, code/design read requirements, body-validation failures, exemptions, and fail-closed analyzer errors in the existing `test:system-map` leg.

**Question for the human:** is a general function call graph wanted later? This design deliberately does not add one.
