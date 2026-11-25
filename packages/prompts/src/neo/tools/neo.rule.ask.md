---
id: neo.rule.ask
---
Default path for standing-rule edits in any Neo turn: ask the human to apply or keep the exact add/remove arrays. Removal uses exact saved text. No rule changes until the human picks apply. The daemon opens the card on its own ask and settles that ask once the edit is applied or the rules are kept; omit askId, which is ignored. Pending retries reuse requestId; question_closed needs a new requestId.
