# Card questions in the web chat

Use the shared isolated setup with a fresh run directory and free daemon/mock
ports, build web, launch, and run doctor. Run:

```sh
NODE_PATH=<playwright node_modules> \
  node .claude/skills/verify/chat-questions-web.mjs "$PORT" "$RUN"
```

The helper seeds a synthetic ask and opens two choice questions over RPC. At
1280 and 390 widths, in light and dark, both questions must appear in the main
chat with enabled answer buttons, inside the viewport, and the page must keep a
single `neo-ref-question-<id>` anchor (the Inbox's). Tapping a chat question's
card title must reveal that question in the Inbox. Answering in the chat must
record the human answer (checked via `neo.question.get`) and remove the row;
Hold in the chat must record the hold, leave the question open and remove the
row. Evidence: screenshots and chat-questions.json under the run's evidence
directory. Stop only the owned daemon/mock and preserve evidence first.
