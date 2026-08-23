---
id: REVIEW_POLICY_GUIDANCE
---
### Review policy: review source and review depth

Two policy knobs govern how review runs. Both have defaults, so silence always has a defined meaning. State the active review source and depth when you start review-relevant work, and record them in your review or gate artifact.

**Review source** — who must pass review before this work is approved:

- `external` — the external AI review bots installed for the repository are the gate.
- `internal` — this workflow's internal reviewer is the gate.
- `both` — both the external bots and the internal reviewer must pass.
- `auto` (default) — discover what actually exists: if external review bots are available for the repository, treat the run as `external` (the internal reviewer verifies the external verdicts and backs them up if the bots fail); if none are, treat it as `internal`.

**Review depth** — how much review effort the change warrants:

- `light` — a small, low-risk diff: one pass by a single reviewer, no fan-out.
- `standard` — the default review: full dimension coverage with the usual dispatch.
- `deep` — a large or high-risk change: the standard review plus an independent second pass on the riskiest dimension.
- `auto` (default) — triage from the diff: `light` for small changes with no contract/schema/auth/protocol/security surface (secret handling, subprocess execution, filesystem access, and new dependencies are security surfaces), `deep` for migrations, auth, protocol, security-sensitive, or cross-package contract changes, `standard` otherwise.

**Precedence and mid-run changes.** An explicit value stated in the task instructions wins over the default. The most recent explicit instruction wins over earlier ones: when a later instruction from the task creator arrives — in an updated task description or as a message delivered to your session — adopt it for the remainder of the run. If two instructions conflict, follow the latest and say so in your output. Never invent a policy the instructions did not state; when the policy is ambiguous, follow the closest reading of the latest instruction and state the interpretation you chose.

