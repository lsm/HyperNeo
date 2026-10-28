# The daemon picks the ask for a human request

Run from the worktree root with a fresh absolute run directory:

```bash
bash .claude/skills/verify/ask-binding-daemon.sh /tmp/hyperneo-ask-binding-fresh
```

The helper starts an isolated in-process daemon (NODE_ENV=test, fresh HOME,
data dir and DB, ephemeral port, no provider, `gh` refuses everything). It seeds
one open ask, sends two consumed human messages through `neo.message.send` (one
new, one replying to that ask) and calls the operations as the Neo session:

- `neo.question.ask {input: <new message>, askId: <unrelated ask>}` opens a new
  ask whose origin is that message and whose request is the human's words; the
  receipt carries an `ask_rebound` record and the unrelated ask gets no question.
- `neo.todo.add {input: <new message>}` lands on that same ask.
- `neo.todo.add {input: <reply to the ask>}` lands on the replied-to ask.
- `askId` alone still works; neither field is an input error; an unknown input
  is refused with `unknown_input`.

Evidence: `evidence/ask-binding.json` holds every receipt plus the `neo_asks`,
`neo_todos` and `neo_questions` rows. No web UI or model turn is involved.
