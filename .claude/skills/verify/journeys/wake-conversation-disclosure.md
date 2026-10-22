# Wake and conversation disclosure controls (#8098)

Use shared setup with a fresh synthetic run, its isolated HOME/data, and a free
port other than 8399. Build the web package before launch, then seed before the
daemon starts:

```sh
RUN=$(mktemp -d /private/tmp/hn-wake-conversation-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/wake-conversation-disclosure-seed.ts "$RUN"
.claude/skills/verify/launch.sh "$PORT" "$RUN"
```

Keep the terminal alive; `doctor.sh "$PORT" "$RUN"` must say usable. No real
provider, model, files, transcript or credentials are used. The fixture includes
a settled wake with attributed content, one Neo-to-worker message, a revised
publication and a permanently failed human ask. It delegates fresh-DB protection
to the base synthetic seed.

Use persistent headless Playwright with a five-second locator timeout. Import
`wake-conversation-disclosure-web.mjs` beside the skill, then call
`verifyWakeConversation(page, {port, run, width, phase})` at widths 1280 and 390.
Use phase before on the committed reproduction and after on the fix. The helper
records JSON and viewport screenshots in `$RUN/evidence/<phase>/` and waits for
finite animations before screenshots.

| Surface / claim | User-visible check and evidence |
| --- | --- |
| Wake summary | Clicking title/summary stays closed; more/Enter opens additions; less/Space closes; focus follows the new button; wake-expanded and collapsed screenshots |
| Session message | Preview stays inert; more reveals complete selectable text; body click/drag never closes it; final-line and right-edge bounds in JSON; session-expanded screenshots |
| Edited history | Edited marker stays inert; explicit more shows ordered original/current text; less sits after the history; copy/reply remain separate; history-expanded screenshots |
| Stored delivery failure | Alert indicator stays inert; more/less controls the reason; edit/resend remains separate; reason-expanded screenshots |
| Native behavior | Native details/open/entry identity retained; question link still opens the owning work card on desktop and the phone sheet; publication href still resolves to its retained article |
| Phone fit | No horizontal overflow; inspect controls, content and composer separately at 390 |

Unit contracts also cover pending-send refusal (reason, retry/edit), native open
synchronization and retaining disclosure state through a wake refresh. The
in-memory pending-send failure is component-covered, not claimed as a real-daemon
network-failure reproduction. No native iOS/live-provider behavior is verified.

Re-run journey 30 for the legacy navigation and pagination regressions in separate
fresh runs. Its seed now writes the fixture transactionally with a busy timeout
because the daemon's background writers can otherwise race the synthetic seed.
The helpers retain their CLI usage and export `verifyNeoWake(page, {port, run})`
and `verifyWakePagination(page, {port, run})` for persistent browser use. Pagination
uses ordinary mouse-wheel input, never direct DOM scroll mutation. Inspect the
Load earlier before/after pair: a newly folded closed wake keeps the prior
publication's position. Native summary text no longer toggles; the explicit
more/less button does.

Close the browser and stop each owned run with `stop.sh "$RUN"`. Preserve evidence
for review. Shared SKILL.md and journey indexes stay unchanged.
