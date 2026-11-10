---
id: neo.preferences.set
---
Set the primary model, provider and thinking level for Neo and its projects, for the user only. Optional fallbacks stores an ordered preference list; runtime recovery uses the ordinary session policy. An empty list clears saved fallbacks; omitting it preserves the saved chain. Optional autoCompactPercent, on the primary and on each fallback, is an integer clamped to 10–100; the entry for the model the Neo session runs writes the ordinary per-session context-budget setting, and omitting it restores model metadata/default. Percentage edits apply after the current reply; a model switch takes its entry's percentage at once.
