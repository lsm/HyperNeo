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

For the earlier sample of 40 merged code PRs (#11521–#11612), I checked out each squash commit and ran `bun run system-map impact --diff <merge-commit>^`. The unique name-linked outside files had median 0 and maximum 80 (#11531); 25 PRs had zero. Importer references had median 2.5 and maximum 278, and can repeat a file across planned paths. Median/max invocation time was 0.26/0.54 s. A full current `map` run took 2.95 s.

I then reran the actual required set with base and head maps. The 40 PRs had no deleted sources or removed definitions, so the result stayed median 0, maximum 80, and 406 required paths in 15 PRs. Five deletion PRs (#11401, #11092, #11048, #10697, #10443) added 10 deleted paths across 101 required paths; none had an outside consumer of a removed definition, so that branch is a fixture-test requirement rather than measured historical noise.

A claim-only alternative needs one attestation and zero path entries per PR, but accounts for none of those 406 paths or the 10 deleted paths. The measured gate adds path entries only in 15 of 40 PRs and catches removed consumers, so it is the smallest useful choice between those two; importer counts stay ungated.

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

Use one lightweight `System map` workflow, registered with the existing CI gate and reusing `scripts/system-map.ts` and `test:system-map`. Keep the main CI workflow's triggers unchanged: body and label events rerun only this check, not the test suites. Add no external service or PR-comment bot.

On a PR event, check out the exact PR head, fetch the event's `base.sha` and `refs/pull/<n>/head` with enough history to find their merge base (the branch's fork point), and save `git diff --name-only --no-renames -z <fork> <head>` with `scripts/system-map-diff.sh` read from `base.sha`, so a branch older than the workflow still runs the matching script. The check compares the branch only with its own fork point, never with the moving `dev` tip, so a `dev` push after the fork point cannot change the result. Then install locked dependencies and run `scripts/system-map-impact.ts`. The wrapper loads the fork-point tree with `git show`, the head tree from the checkout, and reuses `isSource`, `impact`, and `formatImpact` for both maps. It also runs full `map` on the head.

The required set is the sorted union of head `Impact.owned[].peers[]`, head `known: false` paths, and base peers for every owned `(kind, name, role)` removed from the corresponding head file. The saved diff is filtered through `isSource` before either impact call, so the `known: false` arm is solely deleted mapped sources; tests, scripts, native files, and documents never enter the plan. The last arm covers deleted files and definitions removed from files that remain. Importers and nearby table/event lists stay informational. Analyzer or diff failure fails the step; neither can become an empty pass.

### PR-body contract

Every PR has one attestation block. Code needs `impact`, plus `map` when it has no mapped sources. A `docs/design/` change needs `map` and `impact`; other inert docs need `map`. Mixed changes need both. The design author's `impact` claim covers planned files, not just the Markdown. A maintainer-controlled `revert` label waives only path entries, never these read claims:

````markdown
```system-map-impact
{"version":1,"read":["map","impact"]}
{"path":"packages/daemon/src/lib/neo/service.ts","reason":"Checked the event listener; its contract is unchanged."}
```
````

`where` and `routes` may also appear in `read`. CI computes the current head and fork-point base itself and validates required claims plus one non-empty reason per required path. Neither SHA appears in the body: a new head passes with the existing block when its required claims and path set are unchanged, and fails when either changes. The check rejects missing, extra, or duplicate paths, empty reasons, and unknown versions. `--print` performs the same analysis and generates the local block without SHAs. CI prints its exact required block and the head/base SHAs in a collapsed log with the full reports. No PR comment is created.

A validation failure produces one error: `System map check failed: <read/path/reason counts>. Run system-map-impact.ts --print and use the collapsed CI report and replacement block; author read entries are claims.` Analyzer failures instead report the command and head that failed.

The workflow needs no trigger or checkout change: `synchronize` already checks out the exact new head and supplies the current PR body. The implementation PR updates `AGENTS.md`, and therefore the `CLAUDE.md` symlink, in the same change as the check and its tests; live instructions do not change before the behavior ships. Tests-only, native-only, scripts-only, and dependency-only PRs still attest to the required reads; their empty required-path sets need no entries. Native files in a mixed PR remain ignored, deleted mapped sources require entries, and a dependency bump with mapped source is not exempt. The achievable gate is current attestation plus exact analysis, not proof of reading, so there is no broader silent waiver.

The workflow triggers on `opened`, `synchronize`, `reopened`, `edited`, `labeled`, and `unlabeled` PR events, so body edits and the revert waiver revalidate without running main CI. PR runs read event data and make no GitHub API calls, including for forks. Per-PR analysis is about 3 s plus a second impact pass; Bun and dependency setup time were not measured.

### Limits

The required `System map` status is the only merge gate; there is no daemon or merge-wrapper change. `dev` does not require branches to be up to date before merging, and the check does not need it: it reads only the branch since its fork point, so a `dev` push neither reruns nor invalidates it. It also cannot see a peer that `dev` added after the fork point; a rebase brings that peer into the next run. A body edit or label change can race the merge. Direct GitHub merges receive those branch protections, but a required CI check cannot make those windows atomic or prove that an author read the output.

### What CI proves

The CI log proves that `map` and base/head `impact` completed at the recorded SHAs, including removed-definition links, and that the body accounts for the computed path set. `read` entries and reasons are author claims: CI cannot prove the author read any output, ran the same commands locally, or used the result. Design planned-file analysis and `where`/`routes` coverage are likewise claims, not executions inferred by CI.

A false positive gets a reason explaining the wrong link. Missing links still need human feedback. Replace routine #10836 comments with the CI log and body block; keep that issue for missed/wrong links and runtime problems.

The implementation PR adds tests covering the fork-point diff, a `dev` push that leaves the block unchanged, a review-fix push that reuses the unchanged body successfully, a push that changes the required paths and fails against the old body, peer de-duplication, removed-definition peers, deleted sources, ignored importers, every category's attestation, body-validation failures without head/base fields, the revert path-only waiver, label revalidation, and fail-closed analyzer errors in the existing `test:system-map` leg.

**Question for the human:** is a general function call graph wanted later? This design deliberately does not add one.
