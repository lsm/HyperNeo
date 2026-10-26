# Neo model Settings persists the auto-compact percentage

Follow shared isolation setup in SKILL.md and the headless launcher in
[Neo coordinator models](neo-coordinator-models-in-web-settings.md). Build the
current head first, then run the helper with a fresh run directory and two free
ports, never 8399. No human desktop/browser is controlled.

The actual built `/settings?tab=neo-model` page selects a primary/provider and
thinking level, saves 70%, and shows the target calculated from the daemon catalog window (the synthetic SDK
catalog currently returns 200,000, so 70% is 140,000 tokens). The helper checks real daemon `neo.snapshot` returns 70 after both
1280px and 390px reloads, and captures screenshots. It resets to 90 and confirms
the daemon omits `autoCompactPercent`, preserving native provider defaults.
Finally it opens the Neo popover's model list and checks the ordinary Models
page contains no Neo editor. Fallback editing/reordering remains covered.

Evidence: `$RUN/evidence/neo-model-settings.json` plus desktop/mobile PNGs.
The helper always closes its headless browser, synthetic daemon and local mock.
Focused component tests additionally check 1M × 70% = 700K, clamp 1→10 and 101→100, empty and
fractional rejection, refusal retaining edits, and inherited fallback behavior.
This proves Web persistence and displayed target, not a real provider's 700K
compaction timing. Backend reserve/idle/native behavior is proved separately in
[the percentage operation journey](neo-auto-compact-percentage.md).

For repeatable exact-head validation from a clean worktree:

```bash
bash .claude/skills/verify/neo-model-page-check.sh /private/tmp/hn-neo-model-final-UNIQUE
```

This records the head, full repository checks, all Web/shared tests, focused Neo
preference/snapshot daemon suites, build output, and the real headless journey.
Set NODE_PATH or VERIFY_BROWSER as documented in the existing launcher journey.
