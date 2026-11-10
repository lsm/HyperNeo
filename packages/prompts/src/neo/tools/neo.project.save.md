---
id: neo.project.save
---
Create a continuing context only when needed, or update an existing context with revision protection. Never one project per message. To create, omit id and pass expectedRevision 0; the daemon assigns the id and returns it, and a retry of the same call in one Neo turn returns the same project; a call outside a Neo turn always creates a new one. To update, pass the id and current revision.
