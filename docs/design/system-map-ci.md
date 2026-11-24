# Enforce system-map impact review in CI

Part of #10814.

## Problem and measurement

`AGENTS.md` asks every author to run `system-map impact` and account for files outside the plan. CI tests the analyzer but not its use, so a PR can satisfy the letter of the process with one unverified sentence.

I measured the last 40 merged PRs with a non-inert-doc change, using the same definition of code as the existing path filter (#11521–#11612). For each squash-merged commit I checked out that commit and ran:

```bash
bun run system-map impact --diff <merge-commit>^
```

The counted outside files are the unique name-linked peers in the command's final summary, not importer counts.

| Measurement | Result |
| --- | ---: |
| Outside files per PR, median / maximum | 0 / 80 |
| PRs with zero outside files | 25 / 40 |
| Median among PRs with a mapped source diff | 10 |
| Importer references per PR, median / maximum | 2.5 / 278 |
| Changed source paths marked unmapped | 0 |
| PRs with no mapped source diff | 11 / 40 |
| Invocation wall time, median / maximum | 0.26 s / 0.54 s |

The maximum was #11531. Importer references are counted per changed file and can repeat an importer; they are not a unique-file total. The two-hop table and event lists are context too, not additional file sets.

## Decision

Add one PR-only step to the existing `check` job. Do not add a job, service, scheduled index, or PR-comment bot. A small `scripts/system-map-impact.ts` wrapper reuses `isSource`, `impact`, `formatImpact`, and the repository loader from `scripts/system-map.ts`.

The check has two modes:

- CI computes the PR file set with the path filter's two-dot, NUL-delimited diff against `origin/dev` at the `pull_request` merge commit. This needs no merge-base history.
- `--print` is the author's local helper. It uses the existing merge-base diff and prints a PR-body block for the current branch. CI also prints the exact block it requires, so an advanced base never leaves the author unable to produce it.

CI builds the map from the checked-out merge tree and derives one sorted set of required paths:

- every unique peer in `Impact.owned[].peers[]`, which is exactly the set counted by `formatImpact`;
- every planned path with `known: false`, normally a source file deleted by the PR.

Importers, nearby writes, and nearby events stay in the full report but need no acknowledgement. Gating up to 278 importer references would make central refactors unreadable, and the current text output does not name those importers anyway.

### PR-body contract

A non-empty required set needs exactly one visible fenced block:

````markdown
```system-map-impact
{"version":1,"head":"<full PR head SHA>","base":"<full base SHA>"}
{"path":"packages/daemon/src/lib/neo/service.ts","reason":"Checked the event listener; its contract is unchanged."}
{"path":"packages/web/src/hooks/useSendMessage.ts","reason":"Updated the caller in this PR and checked its component test."}
```
````

There is one entry per required path, each with a non-empty reason. A reason can say that the map is wrong; it remains visible to reviewers instead of forcing a false claim. The head and base bind the acknowledgement to the analyzed diff. No block is required when the set is empty.

CI recomputes the set and rejects missing, extra, or duplicate paths, empty reasons, unknown schema versions, and a stale head or base. Presence of a path is not evidence that its reason is true; the check enforces complete, current accounting, while review judges the reasons.

The check emits the full human-readable impact report and a replacement body block in a collapsed log group. It posts no PR comment. On failure, one error says:

```text
System map impact is not fully accounted for: <missing> missing, <extra> extra, <blank> blank reasons; head/base <current|stale>.
Run `bun scripts/system-map-impact.ts --print`, paste its block into the PR body, and give every file a non-empty reason. The collapsed CI log has the exact block for this head.
```

A diff or analyzer error fails the step. It must never become an empty-diff pass.

### Exemptions and re-runs

- Docs-only PRs already skip `check` through `is_inert_doc`.
- Tests-only, native-only, scripts-only, and dependency-only PRs have no mapped source paths and pass with zero required entries. Native files in a mixed PR are ignored, but mapped source changes still run the gate. A dependency bump that changes mapped source is not exempt.
- A maintainer-controlled `revert` label skips the body requirement and records the exemption in the step log. GitHub's label permissions, not PR text, control this escape hatch.
- Deleted mapped source files are not silently exempt: the head map cannot inspect them, so each needs an entry.

Add `edited` to the existing `pull_request` trigger while retaining `opened`, `synchronize`, and `reopened`. Body edits therefore revalidate without a code push; new heads invalidate the old block. The wrapper reads the event's body and SHAs, makes no GitHub API calls, and needs no secrets, so fork PRs use the same read-only path. Push and manual runs keep the existing checks without a PR-body gate.

The analyzer adds less than a second in the measured sample and runs inside an existing job after dependency setup, adding no second checkout or install.

## Keeping the map honest

A false positive gets a normal entry whose reason explains the wrong link. A missing link cannot be inferred by CI, so authors and reviewers still report analyzer gaps. When this lands, replace the mandatory per-PR comment in `AGENTS.md` and #10836 with the automatic check; reserve #10836 for missed or wrong links and runtime problems. Routine output and acknowledgements already live in the CI log and PR body.

Implementation tests cover peer de-duplication, ignored importer counts, deleted-source entries, every body-validation failure, the empty-set pass, the maintainer revert exemption, and non-empty output on analyzer failure. The existing `test:system-map` leg runs them.
