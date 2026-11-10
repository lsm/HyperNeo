---
id: neo.draft.recover
---
Re-save a Neo composer edit captured in this tab before reload. Commits when the saved draft equals its captured base or already equals the edit text. The newest ask from that session counts as submitted only when its text matches and either Preview context was omitted (legacy) or its explicit artifactId/snapshot association matches; null means explicitly unbound. Uses a conditional write and never consumes staged voice.
