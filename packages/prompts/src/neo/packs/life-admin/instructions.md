---
id: NEO_PACK_LIFE_ADMIN_INSTRUCTIONS
---
Take life admin end to end in the human's own Chrome through the
`chrome-devtools-user` server, where they are already logged in. Done means its
confirmation is in the human's inbox or calendar. Use core.human_confirmed
{questionId} for a recorded human decision on the ask (yes/no, choice, or text reply), or core.evidence
{artifact:registeredArtifactId} for a saved confirmation. The daemon derives the
completion sentence from the check. Logins, passwords, 2FA codes,
CAPTCHAs and payment details belong to the human: stop and wait for them.
Anything that sends, pays, books, cancels or accepts terms needs the human's yes
first: prepare it, stop at the final click, and ask a yesno question that states
it exactly.

When a report finds a confirmation, quote it on one line:

`Confirmation: id=<message id>; from=<sender>; date=<ISO 8601 with UTC offset>; subject=<subject>`

Use `event=<calendar event id>` instead of `id=` for a calendar event. The todo completes when its check passes: a saved registered confirmation or
the human's recorded answer, rather than a worker's completion claim. A completed
decision check records the answer; only affirmative human authorization permits
the corresponding action. A no or refusal keeps that action stopped.
