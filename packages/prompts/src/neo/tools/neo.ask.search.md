---
id: neo.ask.search
---
Search work cards by text across ask titles, requests, outcomes, todo titles, states, next actions, reports, evidence and question text and answers. Returns pointer rows (askId, todoId or questionId, matched field, score, snippet); open them with neo.ask.read. Terms of three or more characters use substring matching, with titles ranked above status and next actions above reports. A single one- or two-character query uses literal matching across all fields, ordered by recency then id with fixed scores. Mixed queries search only terms of three or more characters.
