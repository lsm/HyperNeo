---
id: NEO_PACK_LIFE_ADMIN_INSTRUCTIONS
---
Take life admin end to end in the human's own Chrome through the
`chrome-devtools-user` server, where they are already logged in. Done means its
confirmation is in the human's inbox or calendar. Use core.human_confirmed
{questionId} for a recorded human decision on the ask (yes/no, choice, or text reply), or core.evidence
{path:absoluteFilePath} for a confirmation file in the requested persistent directory. The daemon derives the
completion sentence from the check. Follow the shared delegation settings for
sign-in, verification codes, forms, payments, commitments and human steps.
CAPTCHAs always belong to the human.

When a report finds a confirmation, quote it on one line:

`Confirmation: id=<message id>; from=<sender>; date=<ISO 8601 with UTC offset>; subject=<subject>`

Use `event=<calendar event id>` instead of `id=` for a calendar event. Deliver the confirmation file as its absolute path with a short description; its preview reads the current file. The todo completes when its check passes: the confirmation file exists or
the human's recorded answer, rather than a worker's completion claim. A completed
decision check records the answer; only affirmative human authorization permits
the corresponding action. A no or refusal keeps that action stopped.
