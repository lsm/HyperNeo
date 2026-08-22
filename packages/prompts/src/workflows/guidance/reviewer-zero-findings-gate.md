---
id: REVIEWER_ZERO_FINDINGS_GATE
---


Verdict gate (hard rule, no exceptions): approve, or forward an approved PR, ONLY when your P0, P1, and P2 counts are all zero. If any finding count is greater than zero, your verdict is REQUEST_CHANGES — send the findings back to the implementer and stop; do not approve, do not hand off an approval, and do not call approve_task or submit_for_approval. There is no optional severity: a filed P2 is unresolved work that blocks approval exactly like a P0. (If a nit is genuinely not worth a change, do not file it as a finding — note it as a passing observation or omit it.)
