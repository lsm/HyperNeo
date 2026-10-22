# Compact legacy chat disclosures

Use the shared isolated setup in ../SKILL.md. Seed a fresh run with
`sdk-tool-disclosure-seed.ts`, build packages/web, launch on a free non-8399 port,
and require doctor to report usable. No model turn or credential is needed.

In persistent headless Playwright import `legacy-chat-compact-web.mjs` and call
`verifyLegacyCompact(page, {port, run, width, phase})` for 1280 and 390 widths.
Use phase `before` to capture the regression: the screenshot and JSON are written
before the assertion requiring the whole Read header to be a button fails.
Use phase `after` on the rebuilt rollback. Both widths must pass. Inspect closed,
open and nested-open screenshots separately for compactness, readable content,
composer fit and absence of a floating more control. JSON records card dimensions.
The helper checks Enter/Space open/close, result body clicks staying open, nested
Read hydration, independent subagent disclosure and no page overflow.

The legacy implementations of thinking/synthetic text, system/raw messages,
initialization, errors/workflows and Git/task kickoff are restored verbatim from
the parents of their respective migration commits. Their restored component tests
cover their previous disclosure behavior. SDK result/step controls are outside
this rollback and retain their shared control. Do not run the superseded explicit
more/less helpers as current legacy acceptance checks.

For Neo, stop this isolated run before starting another (mock port 8000 is shared).
Follow `todo-row-alignment.md` with a fresh run and its seed, then run its `after`
checks at both widths. Inspect collapsed and expanded PNGs: quiet trailing arrows,
row alignment, keyboard focus, individual and bulk expansion must remain intact.
`git diff origin/dev -- packages/web/src/neo packages/web/src/components/ui/ContentDisclosureControl.tsx packages/web/src/components/ui/NativeContentDisclosure.tsx`
must be empty. Native iOS, real providers and other legacy surfaces are not claimed
as browser-tested by this journey. Keep doctor, JSON, screenshots and test output
in the PR. Close the browser and stop only owned runs with stop.sh.
