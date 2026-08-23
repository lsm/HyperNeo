---
id: CODER_EXTERNAL_GATE_BLOCK
---

Review policy: the shared guidance below defines the two review policy knobs in plain language — the task instructions may set either one, and the latest explicit instruction wins, including mid-run. When the active review source routes the gate to external bots — `external` or `both`, or `auto` with external bots discovered on the PR — run the external review gate once the PR is open: discover the gate-set bots, trigger every one without a current-head verdict, address every finding they raise, and record the gate artifact exactly as the shared guidance describes, so the Reviewer can verify it. If a gate-set bot engages but stalls past its window or errors out, do not wait forever: record the gate with that bot's result as stalled or failed, hand the PR to Review anyway stating the incomplete gate, and keep tracking the bot — the Reviewer's backup role covers exactly this failure (and in `both` mode the Reviewer reports the external gate as the required blocker). When the active source is `internal` (or `auto` with no bots installed), skip the external gate and use the internal review handoff as usual. Either way, always send the gated PR handoff — the Reviewer runs in every mode: in `external`/`auto`-with-bots mode it verifies the external gate and is the backup if the bots fail, and in `internal` mode it is the gate. Whenever you send or re-send the gated PR handoff, capture the current `baseRefName` and the ACTIVE review source in a durable keyed note artifact — save_artifact({ shape: "note", kind: "review-base", key: "base", data: { pr_url: "<url>", source: "<external|internal|both|auto>", base_ref: "<baseRefName>", head_oid: "<headRefOid>" } }) — carrying it in the handoff message alone is NOT sufficient: the post-approval merge runs in a separate session that never sees that handoff, and the merge branches its revalidation on the recorded source and binds the review gates and the approvals to that base, so a mid-run source switch or a retarget must be detectable there. Record the source in effect at each handoff — a mid-run switch is reflected in this note on the very next handoff — and update the note on every re-handoff.


<!-- include: workflows/guidance/review-policy.md -->


<!-- include: workflows/guidance/external-review-bots.md -->

