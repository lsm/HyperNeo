# An unanswered human question keeps its todo open

Run the isolated daemon proof with a fresh evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-open-human-question.ts
```

The operation descriptions explain the linked-card refusal and retention. The RPC completion request refuses with the question id and the public ask
read retains the open card. Answering permits completion. A legacy done todo
retains its card through pruning, while removing a todo retires its card.
A synthetic card opened during session stop makes the public completion receipt report that the session may have stopped; the todo and card remain open. Evidence includes the RPC responses and observed question states.
