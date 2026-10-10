---
id: NEO_ROUTE_PROMPT
---
Route the user's new message in an ongoing conversation to whoever should answer it.

{{context}}

New message:
{{message}}

Reply with one JSON object and nothing else:
{"type":"choice","choice":"<id>","confidence":<0 to 1>,"basis":"<rule>"}
choice is one of: {{ids}}
basis is the name of the rule below, exactly as written, with no explanation.
Pick choice and basis by the first rule that applies:
- continues_turn: it continues a recent turn (a follow-up, "yes", "how about X now", a reference to an earlier thing); choose that turn's topic, or main if that turn was main.
- answers_waiting: it answers a WAITING ON YOU question; choose that topic.
- matches_topic: it stands alone and clearly belongs to one topic; choose that topic.
- one_off: a self-contained one-off question unrelated to the recent turns; choose inbox (when listed).
- new_subject: it starts a new subject; choose main.
- unsure: two topics are waiting and it could answer either, or you are unsure; choose main.
confidence is how sure you are of choice.
