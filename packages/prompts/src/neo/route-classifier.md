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
The daemon presents one level of the project tree at a time. Pick only among the listed candidates; if the current project is listed alongside its sections, choose it to stay there. The daemon descends after your selection. Facts resolved by the daemon take priority over this text classification. Never route across project boundaries because of wording alone.
Pick choice and basis by the first rule that applies:
- answers_waiting: it answers a WAITING ON YOU question; choose whoever asked it, main included.
- continues_turn: it replies to a recent turn (a follow-up, "yes", "how about X now", a reference to an earlier thing); choose that turn's project. Choose main only when it replies to main's last message.
- matches_project: it belongs to an existing project by its title, repository or summary; choose that project.
- new_subject: it starts a new project, idea or ongoing project; choose main and include projectTitle naming its actual target (for example "HyperNeo" or "Japan trip"). Never copy the message's first line or use an instruction as the title. If the target is unclear, omit projectTitle so root can clarify.
- one_off: a self-contained one-off question unrelated to any project; choose inbox (when listed).
- cross_project: it asks about work across projects ("how is everything going?"); choose main.
- unsure: two projects are waiting and it could answer either, or you truly cannot tell; choose main.
Main's past turns are not a project: a message never matches main because main discussed something similar before.
confidence is how sure you are of choice.
