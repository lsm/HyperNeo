# Settled question previews (#9086 item 4)

Use SKILL.md resource guards, fresh HOME/data and existing dependencies. Build
web first. The helper owns an isolated real daemon, disables external HTTP and
providers, seeds only synthetic answered, retired, short and open questions, and
checks the real neo.ask.read operation before serving the actual built assets.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-settled-question-preview.ts before "$READY"
```

Use fresh evidence and ready paths. Keep the owning shell alive. The ready JSON
contains its ephemeral URL, run and PID. Before the fix, open the Work card's
All dialog: both long rows render over 2,500 characters without Read all. Capture
both viewports and save browser.json with phase before and baselineReproduced.

For the fix, rebuild the exact committed head and launch with after. Read the
shared QA inventory before browser testing. In persistent headed Playwright,
create desktop 1280x900 light and touch 390x844 dark contexts. Import
verifySettledPreview from the adjacent neo-settled-question-preview-web.mjs and
invoke it one viewport at a time with {touch,evidence:'<run>/evidence'}.

Inspect initial, preview and complete-question screenshots. Both settled bodies
must be short, with answer/date or retirement reason visible. Read all opens the
complete safe Markdown including its final table/link/text; only this dialog
renders that full body. Close returns to the bounded preview. Short questions
have no Read all. View full report still opens the separate literal document.
Open-question answer controls remain available. Component tests cover Chinese
labels, safe Markdown and attached artifacts. Confirm dialog bounds and no
horizontal overflow; vertical scrolling is intentional for long full text.
Explore repeated open/close, keyboard Escape and focus return, then inspect
late full-text content and the returned preview. Preserve evidence of failures;
an inconclusive check is not a pass. Save browser.json with phase after and
passed true only after functional, visual and viewport checks pass.

Close owned browser contexts and signal the helper PID with SIGUSR1. Its finally
stops the preview, WebSocket and daemon. The wrapper saves evidence then deletes
its temporary HOME/data. Require wrapper exit zero. Run the NeoAskTodos suite
and full check on the final head before publishing.

The work-card history now lives in the All dialog; see neo-all-items-dialog.md
for paging and nested-modal checks. Deployment smoke needs a containing served
build and explicit permission for a read-only browser check. Never restart or
mutate the live daemon. Isolated proof alone does not establish live verification.
The other #9086 items are outside this slice.
