---
id: neo.coding.assign
---
Assign Review or Verify on one existing coding todo/PR/head/acceptance contract. Configured bot means no reviewer session; otherwise select a provenance-qualified fresh reviewer or explicit human. Verify starts independently. Candidates are available configurations (default first); shared prefer settings return fallback explanations. Existing exact-head assignments are reused; no merge/completion decisions.
For independent review after bot approval, first use work.send for the same todo and reviewer. Then call this operation with handoff {state: "pending", ref, receipt} using its accepted delivery receipt and candidates: []. Bot assignment stays separate. When that review returns or is cancelled, call handoff {state: "returned" or "cancelled", ref}. Missing or uncertain delivery cannot cover a hold.
