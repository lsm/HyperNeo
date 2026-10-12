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
- answers_waiting: it answers a WAITING ON YOU question; choose whoever asked it, main included.
- continues_turn: it replies to a recent turn (a follow-up, "yes", "how about X now", a reference to an earlier thing); choose that turn's topic. Choose main only when it replies to main's last message.
- matches_topic: it belongs to an existing topic by its title, summary or open asks; choose that topic.
- new_subject: it starts a new project, idea or ongoing concern; choose main, and a new topic is created for it.
- one_off: a self-contained one-off question unrelated to any topic; choose inbox (when listed).
- cross_topic: it asks about work across topics ("how is everything going?"); choose main.
- unsure: two topics are waiting and it could answer either, or you truly cannot tell; choose main.
Main's past turns are not a topic: a message never matches main because main discussed something similar before.
confidence is how sure you are of choice.
