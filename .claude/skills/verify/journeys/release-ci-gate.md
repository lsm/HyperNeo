# Release CI evidence gate

The user surface is the release workflow's CI evidence check. No daemon,
provider, browser, or production data is needed. Use a disposable HOME and
TMPDIR, then run from the checkout:

```sh
bash scripts/test-release-ci-gate.sh
```

The helper invokes the same gate used by the release workflow with a synthetic
GitHub CLI. It must exit zero and report that only a completed successful dev
push for the exact commit is accepted. The helper also requires missing,
running, failed, cancelled, wrong-commit, wrong-branch, manual, malformed, and
unavailable evidence to refuse publication. A later failed run cannot be
masked by an older success.

The release workflow retains version and ancestry checks and compares the tag
ratchets with the tagged commit's first parent. Its publishing retry runs the
same evidence gate; a build-only dispatch does not publish or need CI evidence.
This synthetic proof does not publish a release or exercise GitHub's scheduler.
