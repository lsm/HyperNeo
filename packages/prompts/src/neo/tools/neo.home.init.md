---
id: neo.home.init
---
Initialize the local Neo home repository, ignore coordinator transcripts, and assign stable project folders. The local human may supply remoteUrl once to clone an existing shared home; origin/upstream remember the selection. Preserves local transcripts and refuses existing documents or a different origin. Clone is noninteractive with a 30-second timeout. After first setup, call neo.home.github with the current root askId to offer its private remote once. Uses the configured git identity; fix identity/signing configuration and retry if commit fails. Root Neo or the local user only.
