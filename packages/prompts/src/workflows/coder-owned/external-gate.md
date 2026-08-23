---
id: CODER_EXTERNAL_GATE_BLOCK
---

Review policy: the shared guidance below defines the two review policy knobs in plain language — the task instructions may set either one, and the latest explicit instruction wins, including mid-run. When the active review source routes the gate to external bots — `external` or `both`, or `auto` with external bots discovered on the PR — run the external review gate once the PR is open: discover the gate-set bots, trigger every one without a current-head verdict, address every finding they raise, and record the gate artifact exactly as the shared guidance describes, so the Reviewer can verify it. When the active source is `internal` (or `auto` with no bots installed), skip the external gate and use the internal review handoff as usual. Either way, always send the gated PR handoff — the Reviewer runs in every mode: in `external`/`auto`-with-bots mode it verifies the external gate and is the backup if the bots fail, and in `internal` mode it is the gate.


<!-- include: workflows/guidance/review-policy.md -->


<!-- include: workflows/guidance/external-review-bots.md -->

