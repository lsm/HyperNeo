---
id: pack.preferences.ask
---
Ask the human to apply typed pack settings. The daemon displays and binds this exact immutable proposal as a choice to apply these settings or keep the current ones; no settings change until the human picks apply. The daemon opens the card on its own ask, which holds no other work and settles once a value is applied or the current ones are kept; omit askId, which is ignored. To offer a pick among values, pass alternatives (2–5 value sets) instead of values: each becomes one option before keep, and only the option the human picks is applied. Reuse requestId for pending retries; question_closed means use a new requestId to ask again.
