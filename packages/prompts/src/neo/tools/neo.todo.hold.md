---
id: neo.todo.hold
---
Hold a todo that must wait: give the reason, and the daemon stops a running worker without asking the human again. Pass reason null to release it. After releasing a started todo, use neo.todo.continue to resume its worker. To ask the human to start, resume or remove it, pass decision true and make reason the question in their language; the daemon opens a decision card instead. Never hold a todo to wait for another step of the same ask: use after.

To release on PR merge, set until to {pack: "coding", kind: "pr_merged", params: {urls: [...]}} with the exact PR URLs. Set reviewAt to an epoch timestamp in milliseconds up to 30 days from now, or use the default of one day for a plain hold and seven days for a conditional hold. Neo is reminded if a named PR closes without merging or the review time arrives. Decision cards accept neither field.
