# Snapshot updates preserve an open card's details

Use shared isolation, build and resource setup in SKILL.md and the synthetic
Work-card fixture from work-card-summaries.md. Do not use the live daemon.

Open a card while its neo.ask.read response is held. Refresh the full snapshot
several times without changing that ask. There must still be exactly one detail
read; releasing its response must display the full body. Further equivalent
snapshot objects must retain that body and must not retry a failed read either.

Update the ask while the first detail response is held. Several revisions must
coalesce into one follow-up read after the first response completes. Keep the
previously loaded body visible during that follow-up, and display the newest
body when it completes. Card state/title/count updates remain visible throughout.

Closing or switching cards must invalidate the old pending response. A different
ask must never render that response; reopening after failure may explicitly retry.
The repeatable component regression is NeoAskTodos.refresh.test.tsx. Browser
verification on the published head must repeat the held-response scenarios on
the actual Work surface; component assertions alone are not a browser pass.
